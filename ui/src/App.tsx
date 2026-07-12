import type { Component } from 'solid-js'
import ConnectionBadge from './components/ConnectionBadge'
import MasterControls from './components/MasterControls'
import PowerToggle from './components/PowerToggle'
import ProfileTabs from './components/ProfileTabs'
import './App.css'

/**
 * Root shell — power, profiles, master controls, connection
 * (Slices 05 #13, 10 #18, 14 #22).
 */
const App: Component = () => (
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">DolbyX</h1>
      <ConnectionBadge />
    </header>
    <PowerToggle />
    <ProfileTabs />
    <MasterControls />
  </main>
)

export default App
