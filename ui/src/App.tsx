import type { Component } from 'solid-js'
import ConnectionBadge from './components/ConnectionBadge'
import EqPresetPicker from './components/EqPresetPicker'
import LanToggle from './components/LanToggle'
import MasterControls from './components/MasterControls'
import PowerToggle from './components/PowerToggle'
import ProfileTabs from './components/ProfileTabs'
import Visualizer from './components/Visualizer'
import { state } from './store/state'

/**
 * Root shell — power, LAN access, profiles, EQ presets, visualizer,
 * master controls, connection (Slices 05 #13, 10 #18, 14 #22, 15 #23,
 * 16 #24; LAN access #70). `app--off` is the whole-UI power marker
 * every skin reads (ADR-0011).
 */
const App: Component = () => (
  <main class="app" classList={{ 'app--off': !state.power }}>
    <header class="app__header">
      <h1 class="app__title">DolbyX</h1>
      <ConnectionBadge />
    </header>
    <PowerToggle />
    <LanToggle />
    <ProfileTabs />
    <EqPresetPicker />
    <Visualizer />
    <MasterControls />
  </main>
)

export default App
