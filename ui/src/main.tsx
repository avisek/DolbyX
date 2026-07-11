/* @refresh reload */
import { render } from 'solid-js/web'
import './styles/theme.css'
import './styles/base.css'
import App from './App'

// Devs visiting :5173 directly get no daemon-injected bootstrap — bounce
// them to the daemon, the single front door (ADR-0006).
if (!window.__BOOTSTRAP__) {
  location.replace('http://localhost:9876' + location.pathname)
  throw new Error('Bootstrap missing — redirecting to daemon')
}

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing')

render(() => <App />, root)
