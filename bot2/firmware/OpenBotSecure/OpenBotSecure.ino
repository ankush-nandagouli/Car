#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// PHONE'S mobile hotspot credentials. Do not commit real values to a public repo.
const char* HOTSPOT_SSID = "CHANGE_ME_HOTSPOT_NAME";
const char* HOTSPOT_PASSWORD = "CHANGE_ME_HOTSPOT_PASSWORD";

// Signaling host only (no https:// and no path). Render TLS is on port 443.
const char* SIGNALING_HOST = "YOUR-SIGNALING-SERVICE.onrender.com";
const uint16_t SIGNALING_PORT = 443;
const char* SIGNALING_PATH = "/ws";
const char* ESP32_TOKEN = "REPLACE_WITH_ESP32_TOKEN_FROM_SERVER_ENV";
const char* ROOM_ID = "REPLACE_WITH_ROOM_ID_FROM_SERVER_ENV";

// REQUIRED: paste the trusted root CA PEM for the TLS certificate chain used by SIGNALING_HOST.
// Do not use setInsecure(). An empty/incorrect CA will fail closed and refuse connection.
static const char ROOT_CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_TRUSTED_ROOT_CA_PEM_HERE
-----END CERTIFICATE-----
)EOF";

// Placeholder GPIOs only. VERIFY your exact board and BTS7960 wiring before connecting motors.
static const int L_RPWM=4, L_LPWM=5, L_REN=6, L_LEN=7;
static const int R_RPWM=15, R_LPWM=16, R_REN=17, R_LEN=18;
// PLACEHOLDER: verify this pin on your exact ESP32-S3 board. MG995 signal only.
static const int SERVO_PIN=8;
static const int PWM_FREQ=18000, PWM_RES=8;
static const uint32_t COMMAND_TIMEOUT_MS=400;
static const uint32_t STATUS_INTERVAL_MS=1000;

WebSocketsClient webSocket;
Servo headServo;
int servoAngle=90;
int currentL=0,currentR=0;
uint32_t lastDriveMs=0,lastStatusMs=0;
bool authenticated=false,wsStarted=false;

void oneMotor(int rpwm,int lpwm,int speed){
  speed=constrain(speed,-255,255);
  if(speed>0){ledcWrite(rpwm,speed);ledcWrite(lpwm,0);}
  else if(speed<0){ledcWrite(rpwm,0);ledcWrite(lpwm,-speed);}
  else{ledcWrite(rpwm,0);ledcWrite(lpwm,0);}
}
void stopMotors(){
  currentL=0;currentR=0;
  oneMotor(L_RPWM,L_LPWM,0);oneMotor(R_RPWM,R_LPWM,0);
  digitalWrite(L_REN,LOW);digitalWrite(L_LEN,LOW);digitalWrite(R_REN,LOW);digitalWrite(R_LEN,LOW);
}
void enableDrivers(bool on){
  digitalWrite(L_REN,on?HIGH:LOW);digitalWrite(L_LEN,on?HIGH:LOW);
  digitalWrite(R_REN,on?HIGH:LOW);digitalWrite(R_LEN,on?HIGH:LOW);
}
void setMotors(int l,int r){
  currentL=constrain(l,-255,255);currentR=constrain(r,-255,255);
  enableDrivers(currentL!=0||currentR!=0);
  oneMotor(L_RPWM,L_LPWM,currentL);oneMotor(R_RPWM,R_LPWM,currentR);
  if(currentL==0&&currentR==0)stopMotors();
}
void sendJson(JsonDocument& doc){String out;serializeJson(doc,out);webSocket.sendTXT(out);}
void setServo(int angle){servoAngle=constrain(angle,10,170);headServo.write(servoAngle);Serial.printf("Servo angle: %d\n",servoAngle);}
void sendStatus(){
  StaticJsonDocument<256> d;d["type"]="status";d["left"]=currentL;d["right"]=currentR;
  d["wifi"]=WiFi.status()==WL_CONNECTED;d["ip"]=WiFi.localIP().toString();
  sendJson(d);
}
void authenticate(){
  StaticJsonDocument<256> d;d["type"]="auth";d["role"]="esp32";d["room"]=ROOM_ID;d["token"]=ESP32_TOKEN;sendJson(d);
}
void webSocketEvent(WStype_t type,uint8_t * payload,size_t length){
  if(type==WStype_CONNECTED){Serial.println("TLS WebSocket connected; authenticating");authenticated=false;authenticate();return;}
  if(type==WStype_DISCONNECTED){Serial.println("WSS disconnected; stopping motors");authenticated=false;stopMotors();return;}
  if(type==WStype_ERROR){Serial.println("WSS/TLS error; fail-safe stop");authenticated=false;stopMotors();return;}
  if(type!=WStype_TEXT)return;
  StaticJsonDocument<512> d;
  if(deserializeJson(d,payload,length)){Serial.println("Invalid JSON");return;}
  const char* t=d["type"]|"";
  if(!strcmp(t,"authenticated")){authenticated=true;Serial.println("ESP32 authenticated with server");StaticJsonDocument<64> r;r["type"]="ready";sendJson(r);return;}
  if(!authenticated)return;
  if(!strcmp(t,"control")){
    int l=d["left"]|0,r=d["right"]|0;
    if(l < -255 || l > 255 || r < -255 || r > 255){stopMotors();return;}
    setMotors(l,r);lastDriveMs=millis();return;
  }
  if(!strcmp(t,"stop")){stopMotors();lastDriveMs=millis();return;}
  if(!strcmp(t,"servo")){int a=d["angle"]|90;if(a<10||a>170)return;setServo(a);return;}
}
void connectWifi(){
  WiFi.mode(WIFI_STA);WiFi.setSleep(false);
  WiFi.begin(HOTSPOT_SSID,HOTSPOT_PASSWORD);
  Serial.print("Joining phone hotspot");
  uint32_t start=millis();
  while(WiFi.status()!=WL_CONNECTED && millis()-start<20000){delay(250);Serial.print(".");}
  Serial.println();
  if(WiFi.status()==WL_CONNECTED){Serial.print("Hotspot joined; IP: ");Serial.println(WiFi.localIP());}
  else Serial.println("Hotspot not connected; will retry");
}
void setup(){
  Serial.begin(115200);delay(300);
  pinMode(L_REN,OUTPUT);pinMode(L_LEN,OUTPUT);pinMode(R_REN,OUTPUT);pinMode(R_LEN,OUTPUT);
  ledcAttach(L_RPWM,PWM_FREQ,PWM_RES);ledcAttach(L_LPWM,PWM_FREQ,PWM_RES);
  ledcAttach(R_RPWM,PWM_FREQ,PWM_RES);ledcAttach(R_LPWM,PWM_FREQ,PWM_RES);
  stopMotors();
  // Servo signal is powered from ESP32 GPIO; MG995 must use separate regulated 5-6 V power.
  // Install the ESP32Servo library in Arduino Library Manager.
  headServo.setPeriodHertz(50);headServo.attach(SERVO_PIN,500,2500);setServo(90);
  if(String(ROOT_CA_CERT).indexOf("PASTE_TRUSTED_ROOT_CA_PEM_HERE")>=0){
    Serial.println("FATAL: trusted root CA not configured. TLS intentionally disabled by fail-closed behavior.");
    while(true){stopMotors();delay(1000);}
  }
  connectWifi();
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);
  // TLS certificate validation is enabled through the configured CA. Never use setInsecure().
  webSocket.beginSslWithCA(SIGNALING_HOST,SIGNALING_PORT,SIGNALING_PATH,ROOT_CA_CERT,"openbot-secure");
  webSocket.enableHeartbeat(15000,3000,2);
  wsStarted=true;
}
void loop(){
  if(WiFi.status()!=WL_CONNECTED){
    stopMotors();
    static uint32_t retry=0;
    if(millis()-retry>8000){retry=millis();connectWifi();}
  }
  if(wsStarted)webSocket.loop();
  if((currentL||currentR)&&millis()-lastDriveMs>COMMAND_TIMEOUT_MS){Serial.println("Drive watchdog timeout");stopMotors();}
  if(authenticated&&millis()-lastStatusMs>STATUS_INTERVAL_MS){lastStatusMs=millis();sendStatus();}
  delay(1);
}
