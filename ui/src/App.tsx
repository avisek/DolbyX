import type { Component } from 'solid-js'
import ConnectionBadge from './components/ConnectionBadge'
import PowerToggle from './components/PowerToggle'
import './App.css'

/** Root shell — the tracer bullet's control surface (Slice 05, #13). */
const App: Component = () => (
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">DolbyX</h1>
      <ConnectionBadge />
    </header>
    <PowerToggle />
  </main>
)

export default App
