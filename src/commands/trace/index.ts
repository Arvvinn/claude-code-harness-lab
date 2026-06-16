import type { Command } from '../../commands.js'

const trace = {
  type: 'local',
  name: 'trace',
  description: 'Show or change harness trace mode',
  argumentHint: '[status|off|learn|full|tail]',
  supportsNonInteractive: false,
  load: () => import('./trace.js'),
} satisfies Command

export default trace
