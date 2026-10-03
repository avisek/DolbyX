/* @refresh reload */
import { render } from 'solid-js/web'
import App from './App'
import { applySkin } from './store/skin'
import { startWs } from './store/ws'

// Devs visiting :5173 directly get no daemon-injected bootstrap — bounce
// them to the daemon, the single front door (ADR-0006), on the same
// host: a phone tapping Vite's printed network URL must not land on
// its own localhost (issue #72).
if (!window.__BOOTSTRAP__) {
  location.replace(`http://${location.hostname}:9876${location.pathname}`)
  throw new Error('Bootstrap missing — redirecting to daemon')
}

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing')

// The chosen skin paints before the first render — its text is already
// in the bundle, the id in the bootstrap (ADR-0013): no flash, no fetch.
applySkin(window.__BOOTSTRAP__.state.skin)
render(() => <App />, root)

// First paint is already fully populated from the bootstrap — the WS
// only reconciles drift and carries commands (ADR-0006).
startWs()
