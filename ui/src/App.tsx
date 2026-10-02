import type { Component } from 'solid-js'
import AdvancedPanel from './components/AdvancedPanel'
import ConnectionBadge from './components/ConnectionBadge'
import EqPresetPicker from './components/EqPresetPicker'
import LanToggle from './components/LanToggle'
import MasterControls from './components/MasterControls'
import PowerToggle from './components/PowerToggle'
import ProfileTabs from './components/ProfileTabs'
import PrototypeBar from './components/PrototypeBar'
import SkinPicker from './components/SkinPicker'
import Visualizer from './components/Visualizer'
import { state } from './store/state'

/**
 * Root Shell — header (wordmark, connection badge, power), LAN access,
 * profiles, EQ presets, visualizer, master controls, the Advanced panel
 * (Slices 05 #13, 10 #18, 14 #22, 15 #23, 16 #24; LAN access #70;
 * Advanced #85; header #117). Fixed DOM order; the skin lays it out.
 * `app--off` is the whole-UI power marker every skin reads (ADR-0011).
 */
const App: Component = () => (
  <main class="app" classList={{ 'app--off': !state.power }}>
    <header class="app__header">
      <h1 class="app__title">DolbyX</h1>
      <ConnectionBadge />
      <PowerToggle />
    </header>
    <ProfileTabs />
    <EqPresetPicker />
    <Visualizer />
    <MasterControls />
    {/* PROTOTYPE (#129): LAN Access moves beside the Skin picker —
        Master controls → LAN Access → Skin → Advanced. */}
    <LanToggle />
    <SkinPicker />
    <AdvancedPanel />
    {/* Always on, prod builds included — the variants have to be
        judged on live audio through EqualizerAPO. */}
    <PrototypeBar />
  </main>
)

export default App
