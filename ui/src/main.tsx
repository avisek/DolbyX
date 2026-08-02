/* @refresh reload */
import { render } from 'solid-js/web'
import './styles/theme.css'
import './styles/base.css'
import App from './App'
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

render(() => <App />, root)

// First paint is already fully populated from the bootstrap — the WS
// only reconciles drift and carries commands (ADR-0006).
startWs()
