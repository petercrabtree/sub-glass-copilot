export type ViewerShortcutAction =
  | 'step_backward'
  | 'step_forward'
  | 'open_reddit'
  | 'open_media'
  | 'rate_up'
  | 'rate_down';

export interface ViewerShortcut {
  action: ViewerShortcutAction;
  group: 'Navigate' | 'Actions';
  description: string;
  displayKeys: readonly string[];
  matchKeys: readonly string[];
  preventDefault?: boolean;
}

const VIEWER_SHORTCUTS: readonly ViewerShortcut[] = [
  {
    action: 'step_backward',
    group: 'Navigate',
    description: 'Previous gallery item or post',
    displayKeys: ['\u2190', 'H', '\u2191', 'K'],
    matchKeys: ['ArrowLeft', 'h', 'ArrowUp', 'k'],
    preventDefault: true,
  },
  {
    action: 'step_forward',
    group: 'Navigate',
    description: 'Next gallery item or post',
    displayKeys: ['\u2192', 'L', '\u2193', 'J', 'Space'],
    matchKeys: ['ArrowRight', 'l', 'ArrowDown', 'j', 'space'],
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
    displayKeys: ['U'],
    matchKeys: ['u'],
  },
  {
    action: 'rate_down',
    group: 'Actions',
    description: 'Rate down',
    displayKeys: ['D'],
    matchKeys: ['d'],
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

export const VIEWER_SHORTCUT_GROUPS = ['Navigate', 'Actions'].map((group) => ({
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
