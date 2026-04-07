export type ViewerShortcutAction =
  | 'skip_backward'
  | 'skip_forward'
  | 'step_backward'
  | 'step_forward'
  | 'open_reddit'
  | 'open_media'
  | 'rate_up'
  | 'rate_down'
  | 'toggle_auto_forward'
  | 'display_fill'
  | 'display_scroll'
  | 'display_masonry'
  | 'display_wild'
  | 'display_wild2'
  | 'display_wild3';

export interface ViewerShortcut {
  action: ViewerShortcutAction;
  group: 'Navigate' | 'Actions' | 'Display';
  description: string;
  displayKeys: readonly string[];
  matchKeys: readonly string[];
  preventDefault?: boolean;
}

const VIEWER_SHORTCUTS: readonly ViewerShortcut[] = [
  {
    action: 'skip_backward',
    group: 'Navigate',
    description: 'Previous post',
    displayKeys: ['\u2190', 'H'],
    matchKeys: ['ArrowLeft', 'h'],
    preventDefault: true,
  },
  {
    action: 'skip_forward',
    group: 'Navigate',
    description: 'Next post',
    displayKeys: ['\u2192', 'L'],
    matchKeys: ['ArrowRight', 'l'],
    preventDefault: true,
  },
  {
    action: 'step_backward',
    group: 'Navigate',
    description: 'Previous gallery item or post',
    displayKeys: ['\u2191', 'K'],
    matchKeys: ['ArrowUp', 'k'],
    preventDefault: true,
  },
  {
    action: 'step_forward',
    group: 'Navigate',
    description: 'Next gallery item or post',
    displayKeys: ['\u2193', 'J', 'Space'],
    matchKeys: ['ArrowDown', 'j', 'space'],
    preventDefault: true,
  },
  {
    action: 'open_reddit',
    group: 'Actions',
    description: 'Open Reddit post',
    displayKeys: ['R'],
    matchKeys: ['r'],
  },
  {
    action: 'open_media',
    group: 'Actions',
    description: 'Open media URL',
    displayKeys: ['O'],
    matchKeys: ['o'],
  },
  {
    action: 'rate_up',
    group: 'Actions',
    description: 'Rate up',
    displayKeys: ['W', 'U'],
    matchKeys: ['w', 'u'],
  },
  {
    action: 'rate_down',
    group: 'Actions',
    description: 'Rate down',
    displayKeys: ['S', 'D'],
    matchKeys: ['s', 'd'],
  },
  {
    action: 'toggle_auto_forward',
    group: 'Actions',
    description: 'Pause or resume auto-next',
    displayKeys: ['P'],
    matchKeys: ['p'],
  },
  {
    action: 'display_fill',
    group: 'Display',
    description: 'Switch to fill view',
    displayKeys: ['1'],
    matchKeys: ['1'],
  },
  {
    action: 'display_scroll',
    group: 'Display',
    description: 'Switch to vertical scroll',
    displayKeys: ['2'],
    matchKeys: ['2'],
  },
  {
    action: 'display_masonry',
    group: 'Display',
    description: 'Switch to masonry wall',
    displayKeys: ['3'],
    matchKeys: ['3'],
  },
  {
    action: 'display_wild',
    group: 'Display',
    description: 'Switch to wild mode',
    displayKeys: ['4'],
    matchKeys: ['4'],
  },
  {
    action: 'display_wild2',
    group: 'Display',
    description: 'Switch to wild2 mode',
    displayKeys: ['5'],
    matchKeys: ['5'],
  },
  {
    action: 'display_wild3',
    group: 'Display',
    description: 'Switch to wild3 mode',
    displayKeys: ['6'],
    matchKeys: ['6'],
  },
] as const;

const viewerShortcutByAction = new Map(
  VIEWER_SHORTCUTS.map((shortcut) => [shortcut.action, shortcut])
);

const viewerActionByKey = new Map< string, ViewerShortcutAction >(
  VIEWER_SHORTCUTS.flatMap((shortcut) =>
    shortcut.matchKeys.map((key) => [key, shortcut.action] as const)
  )
);

export const VIEWER_SHORTCUT_GROUPS = ['Navigate', 'Actions', 'Display'].map((group) => ({
  title: group,
  shortcuts: VIEWER_SHORTCUTS.filter((shortcut) => shortcut.group === group),
}));

export function getViewerShortcut(action: ViewerShortcutAction): ViewerShortcut {
  const shortcut = viewerShortcutByAction.get(action);
  if (!shortcut) {
    throw new Error(`Unknown viewer shortcut action: ${action}`);
  }

  return shortcut;
}

export function getViewerActionForKey(key: string): ViewerShortcutAction | undefined {
  return viewerActionByKey.get(normalizeViewerKey(key));
}

export function formatViewerShortcutKeys(action: ViewerShortcutAction): string {
  return getViewerShortcut(action).displayKeys.join(' / ');
}

function normalizeViewerKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'space';
  return key.length === 1 ? key.toLowerCase() : key;
}
