import type { SessionInfo } from '@jellyfin/sdk/lib/generated-client/models/session-info';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';

const getSessionTranscodingBufferPercentage = (session: SessionInfo) => {
    const rawPercentage = session.TranscodingInfo?.CompletionPercentage ?? 0;

    const nowPlayingItem = session.NowPlayingItem;
    const totalRunTimeTicks = nowPlayingItem?.RunTimeTicks;
    const positionTicks = session.PlayState?.PositionTicks;
    const chapters = nowPlayingItem?.Chapters;

    if (
        nowPlayingItem?.Type !== BaseItemKind.AudioBook
        || !totalRunTimeTicks
        || positionTicks == null
        || !chapters
        || chapters.length < 2
    ) {
        return rawPercentage;
    }

    const sortedStarts = chapters
        .map(chapter => chapter.StartPositionTicks ?? 0)
        .sort((a, b) => a - b);

    let currentPartIndex = -1;
    for (let i = 0; i < sortedStarts.length; i++) {
        if (sortedStarts[i] <= positionTicks) {
            currentPartIndex = i;
        }
    }

    if (currentPartIndex === -1) {
        return rawPercentage;
    }

    const partStartTicks = sortedStarts[currentPartIndex];
    const partEndTicks = currentPartIndex + 1 < sortedStarts.length ?
        sortedStarts[currentPartIndex + 1] :
        totalRunTimeTicks;
    const partDurationTicks = partEndTicks - partStartTicks;

    const bookWideTicks = partStartTicks + (rawPercentage / 100) * partDurationTicks;

    return (bookWideTicks / totalRunTimeTicks) * 100;
};

export default getSessionTranscodingBufferPercentage;
