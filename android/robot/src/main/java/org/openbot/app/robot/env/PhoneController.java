package org.openbot.app.robot.env;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;

import androidx.annotation.NonNull;

import org.json.JSONException;
import org.json.JSONObject;
import org.openbot.app.robot.R;
import org.openbot.app.robot.customview.AutoFitSurfaceGlView;
import org.openbot.app.robot.customview.WebRTCSurfaceView;
import org.openbot.app.robot.utils.CameraUtils;

import java.io.IOException;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import timber.log.Timber;

@SuppressWarnings("ResultOfMethodCallIgnored")
public class PhoneController {
  private static final String REQUEST_ROOM_ID = "request-roomId";
  private static PhoneController _phoneController;
  private ConnectionSelector connectionSelector;
  private IVideoServer videoServer;
  private View view = null;
  private WebSocket webSocket;
  private volatile String remoteSessionToken;
  private volatile String remoteRoomId;
  // Web mode only: CONNECTED starts WebRTC for browser. Phone/Flutter/gamepad stay off.
  private boolean webVideoEnabled = false;

  public static PhoneController getInstance(Context context) {
    if (_phoneController == null) {
      synchronized (PhoneController.class) {
        if (_phoneController == null) _phoneController = new PhoneController();
        _phoneController.init(context);
      }
    }

    return _phoneController;
  }

  class DataReceived implements IDataReceived {
    @Override
    public void dataReceived(String commandStr) {
      ControllerToBotEventBus.emitEvent(commandStr);
    }
  }

  private void init(Context context) {
    ControllerConfig.getInstance().init(context);

    videoServer =
        "RTSP".equals(ControllerConfig.getInstance().getVideoServerType())
            ? new RtspServer()
            : new WebRtcServer();

    videoServer.init(context);
    videoServer.setCanStart(true);

    this.connectionSelector = ConnectionSelector.getInstance(context);
    connectionSelector.getConnection().setDataCallback(new DataReceived());

    android.util.Size resolution =
        CameraUtils.getClosestCameraResolution(context, new android.util.Size(640, 360));
    videoServer.setResolution(resolution.getWidth(), resolution.getHeight());

    handleBotEvents();
    createAndSetView(context);
    monitorConnection();
  }

  private void createAndSetView(Context context) {
    if (videoServer instanceof WebRtcServer) {
      view = new org.openbot.app.robot.customview.WebRTCSurfaceView(context);
    } else if (videoServer instanceof RtspServer) {
      view = new org.openbot.app.robot.customview.AutoFitSurfaceGlView(context);
    }
    if (view != null) {
      addVideoView(view, context);
    }
  }

  private void addVideoView(View videoView, Context context) {
    ViewGroup viewGroup = (ViewGroup) ((Activity) context).getWindow().getDecorView();

    ViewGroup.LayoutParams layoutParams =
        new ViewGroup.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT);
    videoView.setLayoutParams(layoutParams);
    videoView.setId(R.id.video_window);
    videoView.setAlpha(0f);
    viewGroup.addView(videoView, 0); // send to back

    if (videoView instanceof WebRTCSurfaceView) {
      videoServer.setView((WebRTCSurfaceView) videoView);
    } else if (videoView instanceof AutoFitSurfaceGlView) {
      videoServer.setView((AutoFitSurfaceGlView) videoView);
    }
  }

  public void connect(Context context) {
    // Phone mode streams video over the same local connection as web mode does
    // over the signaling websocket, so it needs the video server enabled too.
    setWebVideoEnabled(true);
    ILocalConnection connection = connectionSelector.getConnection();

    if (!connection.isConnected()) {
      connection.init(context);
      connection.connect(context);
    } else {
      connection.start();
    }
  }

  public void connectWebServer() {
    setWebVideoEnabled(true);
    closeWebSocketQuietly();
    nodeServerConnect();
  }

  private void closeWebSocketQuietly() {
    if (webSocket != null) {
      webSocket.close(1000, "Web socket closed");
      webSocket = null;
    }
    remoteSessionToken = null;
    remoteRoomId = null;
  }

  private void nodeServerConnect() {
    final ControllerConfig config = ControllerConfig.getInstance();
    final String serverUrl = config.getWebSignalingServerUrl().trim();
    final String username = config.getWebRemoteUsername().trim();
    final String password = config.getWebRemotePassword();
    if (username.isEmpty() || password.isEmpty()) {
      Timber.w("Set Remote Controller Username and Password in Robot app Settings first");
      return;
    }
    Timber.d("Authenticating with the self-hosted web signaling server: %s", serverUrl);
    final OkHttpClient client = new OkHttpClient();
    final JSONObject credentials = new JSONObject();
    try {
      credentials.put("username", username);
      credentials.put("password", password);
      credentials.put("clientType", "robot");
    } catch (JSONException e) {
      Timber.e(e, "Could not create remote login request");
      return;
    }
    RequestBody body = RequestBody.create(
        MediaType.parse("application/json; charset=utf-8"), credentials.toString());
    Request loginRequest = new Request.Builder().url(getLoginApiUrl(serverUrl)).post(body).build();
    client.newCall(loginRequest).enqueue(new Callback() {
      @Override public void onFailure(@NonNull Call call, @NonNull IOException e) {
        Timber.e(e, "Remote login failed; check Internet, server URL, and credentials");
      }

      @Override public void onResponse(@NonNull Call call, @NonNull Response response) throws IOException {
        if (!response.isSuccessful() || response.body() == null) {
          Timber.e("Remote login rejected by server (HTTP %s)", response.code());
          return;
        }
        try {
          JSONObject result = new JSONObject(response.body().string());
          remoteSessionToken = result.getString("token");
          remoteRoomId = result.getString("roomId");
          Request socketRequest = new Request.Builder().url(serverUrl).build();
          WebSocketListener listener = new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, @NonNull Response socketResponse) {
              PhoneController.this.webSocket = socket;
              sendRoomId(socket);
            }
            @Override public void onMessage(@NonNull WebSocket socket, @NonNull String text) {
              if (text.contains(REQUEST_ROOM_ID)) { sendRoomId(socket); return; }
              ControllerToBotEventBus.emitEvent(text);
            }
            @Override public void onFailure(@NonNull WebSocket socket, Throwable t, Response socketResponse) {
              Timber.e(t, "Web signaling WebSocket failed; check the WSS URL and network");
              remoteSessionToken = null;
            }
            @Override public void onClosed(@NonNull WebSocket socket, int code, @NonNull String reason) {
              if (PhoneController.this.webSocket == socket) PhoneController.this.webSocket = null;
              remoteSessionToken = null;
            }
          };
          PhoneController.this.webSocket = client.newWebSocket(socketRequest, listener);
          Timber.d("Authenticated to remote signaling service; opening WebSocket");
        } catch (JSONException e) {
          Timber.e(e, "Remote login response was invalid");
        }
      }
    });
  }

  private String getLoginApiUrl(String websocketUrl) {
    String base = websocketUrl.replaceFirst("^wss://", "https://").replaceFirst("^ws://", "http://");
    if (base.endsWith("/ws")) base = base.substring(0, base.length() - 3);
    while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
    return base + "/api/login";
  }

  private void sendRoomId(WebSocket socket) {
    if (socket == null || remoteSessionToken == null || remoteRoomId == null) {
      Timber.w("Cannot join remote room: sign-in credentials or session token are missing");
      return;
    }
    try {
      JSONObject room = new JSONObject();
      room.put("roomId", remoteRoomId);
      room.put("clientType", "robot");
      room.put("authToken", remoteSessionToken);
      socket.send(room.toString());
      Timber.d("Sent authenticated self-hosted room join");
    } catch (JSONException e) {
      Timber.e(e, "Failed to send web roomId");
    }
  }

  public void disconnect() {
    setWebVideoEnabled(false);
    closeWebSocketQuietly();
    connectionSelector.getConnection().stop();
  }

  private void setWebVideoEnabled(boolean enabled) {
    webVideoEnabled = enabled;
    if (!enabled) {
      videoServer.setConnected(false);
    }
  }

  public void send(JSONObject info) {
    if (webSocket != null && remoteSessionToken != null && remoteRoomId != null) {
      try {
        info.put("roomId", remoteRoomId);
        webSocket.send(info.toString());
      } catch (JSONException e) {
        throw new RuntimeException(e);
      }
    }

    if (connectionSelector.getConnection().isConnected()) {
      connectionSelector.getConnection().sendMessage(info.toString());
    }
  }

  public boolean isConnected() {
    return connectionSelector.getConnection().isConnected();
  }

  private void handleBotEvents() {
    BotToControllerEventBus.subscribe(
        this::send, error -> Timber.d("Error occurred in BotToControllerEventBus: %s", error));
  }

  // Nearby CONNECTED also fires here; only start camera when web mode set webVideoEnabled.
  private void monitorConnection() {
    ControllerToBotEventBus.subscribe(
        "PhoneController.monitor",
        event -> {
          String command = event.getString("command");
          new Handler(Looper.getMainLooper())
              .post(
                  () -> {
                    if ("CONNECTED".equals(command)) {
                      if (webVideoEnabled) {
                        videoServer.setConnected(true);
                      }
                    } else if ("DISCONNECTED".equals(command)) {
                      videoServer.setConnected(false);
                    }
                  });
        },
        error -> Log.d(null, "Error occurred in monitorConnection: " + error),
        event ->
            event.has("command")
                && ("CONNECTED".equals(event.getString("command"))
                    || "DISCONNECTED".equals(event.getString("command"))));
  }

  private PhoneController() {
    if (_phoneController != null) {
      throw new RuntimeException(
          "Use getInstance() method to get the single instance of this class.");
    }
  }
}