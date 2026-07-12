// TEMP: remove once @jellyfin/sdk publishes AudioBookCount on ItemCounts
// (server-side change not yet merged/released upstream).
import '@jellyfin/sdk/lib/generated-client/models/item-counts';

declare module '@jellyfin/sdk/lib/generated-client/models/item-counts' {
    interface ItemCounts {
        'AudioBookCount'?: number;
    }
}
