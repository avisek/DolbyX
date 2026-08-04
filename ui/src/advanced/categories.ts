// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * Category metadata, shaped exactly like the future bootstrap payload.
 * Array order = section display order; `params` order = card display
 * order (parameters.toml table order within each category). One
 * deviation from the toml: `build_license` split into `build` +
 * `license`. Features first, read-only identity last. All 64 params
 * exactly once.
 */
export interface AdvancedCategory {
  readonly name: string
  readonly label: string
  readonly params: readonly string[]
}

export const CATEGORIES: readonly AdvancedCategory[] = [
  {
    name: 'volume_leveller',
    label: 'Volume Leveler',
    params: ['dvla', 'dvli', 'dvlo', 'dvle', 'dvmc', 'dvme'],
  },
  {
    name: 'ieq',
    label: 'Intelligent EQ',
    params: ['ienb', 'iebf', 'iebt', 'ieon', 'iea'],
  },
  {
    name: 'geq',
    label: 'Graphic EQ',
    params: ['geon', 'genb', 'gebf', 'gebg'],
  },
  {
    name: 'dialog_enhancer',
    label: 'Dialog Enhancer',
    params: ['deon', 'dea', 'ded'],
  },
  {
    name: 'volume_maximizer',
    label: 'Volume Maximizer',
    params: ['vmon', 'vmb'],
  },
  {
    name: 'speaker_virtualizer',
    label: 'Speaker Virtualizer',
    params: ['vspe', 'dssb', 'dssa', 'dssf', 'scpe'],
  },
  {
    name: 'headphone_virtualizer',
    label: 'Headphone Virtualizer',
    params: ['vdhe', 'dhsb', 'dhrg'],
  },
  {
    name: 'next_gen_surround',
    label: 'Next Gen Surround',
    params: ['ngon'],
  },
  {
    name: 'audio_regulator',
    label: 'Audio Regulator',
    params: ['arnb', 'arbf', 'arbi', 'arbl', 'arbh', 'arod', 'artp'],
  },
  {
    name: 'audio_optimizer',
    label: 'Audio Optimizer',
    params: ['aocc', 'aonb', 'aobf', 'aobg', 'aoon'],
  },
  {
    name: 'peak_limiter',
    label: 'Peak Limiter',
    params: ['plb', 'plmd', 'test'],
  },
  {
    name: 'endpoint_volume',
    label: 'Endpoint Volume',
    params: ['endp', 'ocf', 'preg', 'pstg', 'vol'],
  },
  {
    name: 'visualizer',
    label: 'Visualizer',
    params: [
      'ven',
      'vnnb',
      'vnbf',
      'vnbg',
      'vnbe',
      'vcnb',
      'vcbf',
      'vcbg',
      'vcbe',
    ],
  },
  { name: 'build', label: 'Build', params: ['bver', 'ver', 'bndl'] },
  { name: 'license', label: 'License', params: ['lcmf', 'lcvd', 'lcpt'] },
]
