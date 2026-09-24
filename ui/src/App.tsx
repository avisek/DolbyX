// PROTOTYPE — throwaway, do not review
import type { Component } from 'solid-js'
import AdvancedPanel from './components/AdvancedPanel'
import ConnectionBadge from './components/ConnectionBadge'
import EqPresetPicker from './components/EqPresetPicker'
import LanToggle from './components/LanToggle'
import MasterControls from './components/MasterControls'
import PowerToggle from './components/PowerToggle'
import ProfileTabs from './components/ProfileTabs'
import Visualizer from './components/Visualizer'
import Switcher from './proto/Switcher'
import { state } from './store/state'

/**
 * Root shell — header (wordmark, connection, power), LAN access,
 * profiles, EQ presets, visualizer, master controls, the Advanced
 * panel. Fixed DOM order; the skin lays it out. `app--off` is the
 * whole-UI power marker every skin reads (ADR-0011).
 */
const App: Component = () => (
  <>
    <main class="app" classList={{ 'app--off': !state.power }}>
      <header class="app__header">
        <h1 class="app__title">DolbyX</h1>
        <ConnectionBadge />
        <PowerToggle />
      </header>
      <LanToggle />
      <ProfileTabs />
      <EqPresetPicker />
      <Visualizer />
      <MasterControls />
      <AdvancedPanel />
    </main>
    <Switcher />
  </>
)

export default App
