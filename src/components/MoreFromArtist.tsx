import React, { useCallback, useMemo } from 'react';
import { useI18n } from '../core/i18n';
import type { SpotifyAlbum, SpotifyPlaylist } from '../core/spotify';

// Types for better organization
type ContentItem = SpotifyAlbum | SpotifyPlaylist;
type ContentType = 'singles' | 'albums' | 'playlists';

interface CollapsedItem {
  id: string;
  img?: string;
  name: string;
}

interface SectionHandlers {
  onSelectAlbum?: (albumId: string) => void;
  onSelectPlaylist?: (playlistId: string) => void;
}

// Utility functions
const getImageUrl = (images: any, resolution: number): string => {
  return (window as any).imageRes?.(images, resolution) || '';
};

const dispatchContentEvent = (type: ContentType, itemId: string, source: string): void => {
  const eventName = type === 'playlists' ? 'freely:selectPlaylist' : 'freely:selectAlbum';
  const detailKey = type === 'playlists' ? 'playlistId' : 'albumId';
  
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: { [detailKey]: itemId, source }
  }));
};

const createCollapsedItems = (buckets: ArtistBuckets): CollapsedItem[] => {
  const map = new Map<string, CollapsedItem>();
  const contentTypes: ContentType[] = ['singles', 'albums', 'playlists'];
  
  contentTypes.forEach(type => {
    const items = buckets[type] as ContentItem[];
    if (Array.isArray(items)) {
      items.forEach(item => {
        if (!map.has(item.id)) {
          map.set(item.id, {
            id: item.id,
            img: getImageUrl(item.images, 3),
            name: item.name
          });
        }
      });
    }
  });
  
  return Array.from(map.values());
};

// Memoized components for better performance
const SectionCard = React.memo(({ 
  item, 
  type, 
  onSelect 
}: { 
  item: ContentItem; 
  type: ContentType; 
  onSelect: (id: string, type: ContentType) => void;
}) => {
  const imageUrl = useMemo(() => getImageUrl(item.images, 1), [item.images]);
  
  const handleClick = useCallback(() => {
    onSelect(item.id, type);
  }, [item.id, type, onSelect]);

  return (
    <li className="shelf-card" title={item.name}>
      <button type="button" className="card-btn" onClick={handleClick}>
        <div className="card-img-wrap">
          <img src={imageUrl} alt={item.name} loading="lazy" />
        </div>
        <div className="card-meta">
          <div className="card-name">{item.name}</div>
        </div>
      </button>
    </li>
  );
});

SectionCard.displayName = 'SectionCard';

const ListSection = React.memo(({ 
  title, 
  type, 
  items, 
  onSelect 
}: { 
  title: string; 
  type: ContentType; 
  items: ContentItem[]; 
  onSelect: (id: string, type: ContentType) => void;
}) => {
  if (!items.length) return null;

  const sectionCards = useMemo(() =>
    items.map(item => (
      <SectionCard
        key={item.id}
        item={item}
        type={type}
        onSelect={onSelect}
      />
    )),
    [items, type, onSelect]
  );

  return (
    <div className={`artist-shelf artist-shelf-${type}`}>
      <h5 className="shelf-title">{title}</h5>
      <ul className="shelf-cards" role="list">
        {sectionCards}
      </ul>
    </div>
  );
});

ListSection.displayName = 'ListSection';

const CollapsedThumb = React.memo(({ item }: { item: CollapsedItem }) => (
  <div key={item.id} className="collapsed-thumb-item" title={item.name}>
    <div className="collapsed-thumb" aria-hidden="true">
      {item.img ? (
        <img 
          src={item.img} 
          alt="" 
          loading="lazy" 
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        item.name.slice(0, 2).toUpperCase()
      )}
    </div>
  </div>
));

CollapsedThumb.displayName = 'CollapsedThumb';

export interface ArtistBuckets {
  singles: SpotifyAlbum[];
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
  loading: boolean;
  error?: string;
  fetched?: boolean;
}

interface MoreFromArtistProps {
  buckets: ArtistBuckets;
  currentArtistName?: string;
  collapsed?: boolean;
  onSelectAlbum?: (albumId: string) => void;
  onSelectPlaylist?: (playlistId: string) => void;
}

CollapsedThumb.displayName = 'CollapsedThumb';

const MoreFromArtist = React.memo(({ 
  buckets, 
  currentArtistName, 
  collapsed, 
  onSelectAlbum, 
  onSelectPlaylist 
}: MoreFromArtistProps) => {
  const { t } = useI18n();

  // Memoized event handler for content selection
  const handleContentSelect = useCallback((id: string, type: ContentType) => {
    if (type === 'playlists') {
      if (onSelectPlaylist) {
        onSelectPlaylist(id);
      } else {
        dispatchContentEvent(type, id, 'artist-more');
      }
    } else {
      if (onSelectAlbum) {
        onSelectAlbum(id);
      } else {
        dispatchContentEvent(type, id, 'artist-more');
      }
    }
  }, [onSelectAlbum, onSelectPlaylist]);

  // Memoized collapsed items computation
  const collapsedItems = useMemo(() => 
    collapsed ? createCollapsedItems(buckets) : []
  , [collapsed, buckets]);

  // Memoized sections data
  const sectionsData = useMemo(() => [
    { title: t('artist.singles'), type: 'singles' as ContentType, items: buckets.singles },
    { title: t('artist.albums'), type: 'albums' as ContentType, items: buckets.albums },
    { title: t('artist.playlists'), type: 'playlists' as ContentType, items: buckets.playlists }
  ], [t, buckets.singles, buckets.albums, buckets.playlists]);

  // Memoized sections rendering
  const sections = useMemo(() =>
    sectionsData.map(({ title, type, items }) => (
      <ListSection
        key={type}
        title={title}
        type={type}
        items={items}
        onSelect={handleContentSelect}
      />
    )),
    [sectionsData, handleContentSelect]
  );

  // Memoized collapsed thumbs
  const collapsedThumbs = useMemo(() =>
    collapsedItems.map(item => (
      <CollapsedThumb key={item.id} item={item} />
    )),
    [collapsedItems]
  );

  // Memoized loading and empty states
  const hasNoContent = useMemo(() => 
    buckets.fetched && 
    !buckets.loading && 
    !buckets.error && 
    !buckets.albums.length && 
    !buckets.singles.length
  , [buckets.fetched, buckets.loading, buckets.error, buckets.albums.length, buckets.singles.length]);

  // Collapsed view
  if (collapsed) {
    return (
      <div className="rt-panel collapsed" role="tabpanel" aria-label={t('artist.moreFrom')}>
        <div className="rt-header" style={{ display: 'flex', justifyContent: 'center' }}>
          <h4 className="panel-title" style={{ margin: 0 }}>
            <span className="material-symbols-rounded gradient-icon" aria-hidden="true">
              artist
            </span>
          </h4>
        </div>
        <div className="collapsed-thumb-list" role="list">
          {collapsedThumbs}
        </div>
      </div>
    );
  }

  // Expanded view
  return (
    <div className="rt-panel" role="tabpanel" aria-label={t('artist.suggestions', 'Artist suggestions')}>
      <div className="rt-header">
        <div className="rt-subheading">
          <span className="rt-artist-name">
            {currentArtistName || t('artist.unknown', 'Artist')}
          </span>
        </div>
      </div>
      {buckets.loading && (
        <div className="rt-placeholder">{t('artist.loadingReleases')}</div>
      )}
      {hasNoContent && (
        <div className="rt-placeholder">{t('artist.noReleases')}</div>
      )}
      {sections}
    </div>
  );
});

// Custom comparison function for React.memo optimization
const arePropsEqual = (prevProps: MoreFromArtistProps, nextProps: MoreFromArtistProps): boolean => {
  return (
    prevProps.collapsed === nextProps.collapsed &&
    prevProps.currentArtistName === nextProps.currentArtistName &&
    prevProps.onSelectAlbum === nextProps.onSelectAlbum &&
    prevProps.onSelectPlaylist === nextProps.onSelectPlaylist &&
    // Deep comparison for buckets object
    prevProps.buckets.loading === nextProps.buckets.loading &&
    prevProps.buckets.error === nextProps.buckets.error &&
    prevProps.buckets.fetched === nextProps.buckets.fetched &&
    prevProps.buckets.singles.length === nextProps.buckets.singles.length &&
    prevProps.buckets.albums.length === nextProps.buckets.albums.length &&
    prevProps.buckets.playlists.length === nextProps.buckets.playlists.length &&
    // Check if array contents changed by comparing first items (reasonable heuristic)
    (prevProps.buckets.singles[0]?.id === nextProps.buckets.singles[0]?.id) &&
    (prevProps.buckets.albums[0]?.id === nextProps.buckets.albums[0]?.id) &&
    (prevProps.buckets.playlists[0]?.id === nextProps.buckets.playlists[0]?.id)
  );
};

MoreFromArtist.displayName = 'MoreFromArtist';

const OptimizedMoreFromArtist = React.memo(MoreFromArtist, arePropsEqual);
OptimizedMoreFromArtist.displayName = 'MoreFromArtist';

export { OptimizedMoreFromArtist as MoreFromArtist };
export default OptimizedMoreFromArtist;
