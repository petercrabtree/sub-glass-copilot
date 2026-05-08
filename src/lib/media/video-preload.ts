export type VideoPreloadState = 'queued' | 'warming' | 'metadata' | 'ready' | 'buffered' | 'error';

export interface VideoPreloadTarget {
  key: string;
  url: string;
  postId: string;
  mediaId: string;
  itemIndex: number;
  postIndex: number;
  title: string;
  priority: number;
  mimeType?: string;
}

export interface VideoPreloadUpdate extends VideoPreloadTarget {
  state: VideoPreloadState;
  bufferedSeconds: number;
  durationSeconds?: number;
  error?: string;
  updatedAt: number;
}

export function createVideoPreloadKey(
  postId: string,
  mediaId: string,
  itemIndex: number,
  url: string
): string {
  return `${postId}:${mediaId}:${itemIndex}:${url}`;
}
