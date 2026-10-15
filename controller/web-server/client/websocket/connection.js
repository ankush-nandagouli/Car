/* OpenBot Web Controller signaling connection with configurable remote endpoint.
 * Upstream WebSocket/WebRTC message flow is retained. For a production deployment,
 * set <meta name="openbot-signaling-url" content="wss://your-domain.example/ws">.
 */
import { ErrorDisplay } from '../utils/error-display.js'

let sharedSocket = null
let onSocketReadyCallback = null

export function Connection () {
  const errDisplay = new ErrorDisplay()
  this.send = () => {}

  const getWebSocketUrl = () => {
    const configured = document.querySelector('meta[name="openbot-signaling-url"]')?.content?.trim()
    if (configured) return configured
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Vite development server proxies /ws to the local Node signaling server.
    // Production deployments should proxy this same path through TLS, or set the
    // meta tag above to a separate wss:// signaling host.
    return `${wsProtocol}//${window.location.host}/ws`
  }

  const connectToServer = () => {
    if (sharedSocket && sharedSocket.readyState === WebSocket.OPEN) return Promise.resolve(sharedSocket)
    if (sharedSocket) { sharedSocket.close(); sharedSocket = null }
    const ws = new WebSocket(getWebSocketUrl())
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000)
      ws.onopen = () => {
        clearTimeout(timeout)
        sharedSocket = ws
        errDisplay.reset()
        if (onSocketReadyCallback) onSocketReadyCallback()
        resolve(ws)
      }
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed')) }
    })
  }

  this.start = async (onData, onReady) => {
    if (onReady) onSocketReadyCallback = onReady
    const ws = await connectToServer()
    this.send = data => {
      if (sharedSocket && sharedSocket.readyState === WebSocket.OPEN) sharedSocket.send(data)
    }
    ws.onmessage = webSocketMessage => {
      try {
        const msg = JSON.parse(webSocketMessage.data)
        if (msg.roomId === 'request-roomId') {
          if (onSocketReadyCallback) onSocketReadyCallback()
          return
        }
      } catch (error) { return }
      onData(webSocketMessage.data)
    }
    ws.onclose = () => {
      errDisplay.set('Disconnected from the server. To reconnect, reload this page.')
      if (sharedSocket === ws) sharedSocket = null
    }
  }

  this.stop = () => {
    if (sharedSocket != null) { sharedSocket.close(); sharedSocket = null }
  }
}
