import type { Component } from 'solid-js'
import ConnectionBadge from './components/ConnectionBadge'
import EqPresetPicker from './components/EqPresetPicker'
import MasterControls from './components/MasterControls'
import PowerToggle from './components/PowerToggle'
import ProfileTabs from './components/ProfileTabs'
import Visualizer from './components/Visualizer'
import './App.css'

/**
 * Root shell — power, profiles, visualizer, EQ presets, master
 * controls, connection (Slices 05 #13, 10 #18, 14 #22, 15 #23, 16 #24)
 * in the original's page order.
 */
const App: Component = () => (
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">DolbyX</h1>
      <ConnectionBadge />
    </header>
    <PowerToggle />
    <ProfileTabs />
    <Visualizer />
    <EqPresetPicker />
    <MasterControls />
  </main>
)

export default App
