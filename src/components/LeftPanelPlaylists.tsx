import React, { useCallback, useMemo, useState } from 'react';
import { useI18n } from '../core/i18n';
import { usePlaylists } from '../core/playlists';

// Constants for better performance
const VIEW_CONFIGS = [
  { v: 'compact', icon: 'view_headline' },
  { v: 'list', icon: 'view_list' },
  { v: 'sm-grid', icon: 'view_module' },
  { v: 'lg-grid', icon: 'view_cozy' }
] as const;

const DEFAULT_FILTERS = {
  query: '',
  tagFilter: '',
  order: 'name' as const,
  orderDir: 'asc' as const,
  view: 'list' as const
};

const DEFAULT_UI_STATE = {
  showFilters: false,
  isCreating: false,
  showAddTag: false
};

// Interfaces for better type safety
interface FilterState {
  query: string;
  tagFilter: string;
  order: 'name' | 'created' | 'tracks';
  orderDir: 'asc' | 'desc';
  view: 'compact' | 'list' | 'sm-grid' | 'lg-grid';
}

interface UIState {
  showFilters: boolean;
  isCreating: boolean;
  showAddTag: boolean;
}

interface Playlist {
  id: string | number;
  name: string;
  tags: string[];
  system?: number | boolean;
  code?: string;
  created_at?: number;
  track_count?: number;
}

// Utility functions
const getGridClass = (view: FilterState['view']): string => {
  switch (view) {
    case 'sm-grid': return 'pl-grid sm';
    case 'lg-grid': return 'pl-grid lg';
    case 'compact': return 'pl-list compact';
    default: return 'pl-list';
  }
};

const getPlaylistId = (playlist: Playlist): string => {
  return (playlist.system && playlist.code === 'favorites') 
    ? 'favorites' 
    : `local:${playlist.id}`;
};

const sortPlaylists = (playlists: Playlist[], order: FilterState['order'], orderDir: FilterState['orderDir']) => {
  return [...playlists].sort((a, b) => {
    // Favorites always first
    const aFav = a.system && a.code === 'favorites';
    const bFav = b.system && b.code === 'favorites';
    if (aFav && !bFav) return -1;
    if (bFav && !aFav) return 1;

    let cmp = 0;
    switch (order) {
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'created':
        cmp = (a.created_at || 0) - (b.created_at || 0);
        break;
      case 'tracks':
        cmp = (a.track_count || 0) - (b.track_count || 0);
        break;
    }
    return orderDir === 'asc' ? cmp : -cmp;
  });
};

export interface LeftPanelPlaylistsProps {
  onSelectPlaylist?: (id: string) => void;
  activePlaylistId?: string;
}

const LeftPanelPlaylists = React.memo(({ 
  onSelectPlaylist, 
  activePlaylistId 
}: LeftPanelPlaylistsProps) => {
  const { t } = useI18n();
  const { playlists, createPlaylist } = usePlaylists();

  // Consolidated state management
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [uiState, setUIState] = useState<UIState>(DEFAULT_UI_STATE);
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [extraTags, setExtraTags] = useState<string[]>([]);

  // Stable filter actions
  const filterActions = useMemo(() => ({
    setQuery: (query: string) => setFilters(prev => ({ ...prev, query })),
    setTagFilter: (tagFilter: string) => setFilters(prev => ({ ...prev, tagFilter })),
    setOrder: (order: FilterState['order']) => setFilters(prev => ({ ...prev, order })),
    setOrderDir: (orderDir: FilterState['orderDir']) => setFilters(prev => ({ ...prev, orderDir })),
    setView: (view: FilterState['view']) => setFilters(prev => ({ ...prev, view })),
    reset: () => setFilters(DEFAULT_FILTERS)
  }), []);

  // Stable UI actions
  const uiActions = useMemo(() => ({
    setShowFilters: (showFilters: boolean) => setUIState(prev => ({ ...prev, showFilters })),
    setIsCreating: (isCreating: boolean) => setUIState(prev => ({ ...prev, isCreating })),
    setShowAddTag: (showAddTag: boolean) => setUIState(prev => ({ ...prev, showAddTag })),
    reset: () => setUIState(DEFAULT_UI_STATE)
  }), []);

  // Memoized derived values
  const derivedTags = useMemo(() => {
    const set = new Set<string>();
    playlists.forEach(p => p.tags.forEach(t => set.add(t)));
    extraTags.forEach(t => set.add(t));
    return Array.from(set).sort();
  }, [playlists, extraTags]);

  // Memoized filtered and sorted playlists
  const filteredPlaylists = useMemo(() => {
    const filtered = playlists
      .filter(p => !filters.query || p.name.toLowerCase().includes(filters.query.toLowerCase()))
      .filter(p => !filters.tagFilter || p.tags.includes(filters.tagFilter));
    
    return sortPlaylists(filtered, filters.order, filters.orderDir);
  }, [playlists, filters.query, filters.tagFilter, filters.order, filters.orderDir]);

  // Memoized UI state calculations
  const gridClass = useMemo(() => getGridClass(filters.view), [filters.view]);
  
  const hasActiveFilters = useMemo(() => 
    !!filters.tagFilter || 
    filters.order !== 'name' || 
    filters.orderDir !== 'asc' || 
    filters.view !== 'list'
  , [filters.tagFilter, filters.order, filters.orderDir, filters.view]);

  // Event handlers
  const handleCreatePlaylist = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    
    await createPlaylist(name);
    try {
      setNewName('');
      uiActions.setIsCreating(false);
      filterActions.setTagFilter('');
      filterActions.setQuery('');
    } catch (err) {
      console.error(err);
    }
  }, [newName, createPlaylist, uiActions, filterActions]);

  const handleResetCreate = useCallback((e?: React.MouseEvent | React.KeyboardEvent) => {
    try {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    } catch (_) {}
    setNewName('');
    uiActions.setIsCreating(false);
  }, [uiActions]);

  const handleAddTag = useCallback(() => {
    const val = newTag.trim();
    if (val && !derivedTags.includes(val)) {
      setExtraTags(list => [...list, val]);
      filterActions.setTagFilter(val);
    }
    setNewTag('');
    uiActions.setShowAddTag(false);
  }, [newTag, derivedTags, filterActions, uiActions]);

  const handleSelectPlaylist = useCallback((playlistId: string) => {
    if (onSelectPlaylist) {
      onSelectPlaylist(playlistId);
    } else {
      try {
        window.dispatchEvent(new CustomEvent('freely:selectPlaylist', {
          detail: { playlistId, source: 'left-panel' }
        }));
      } catch {}
    }
  }, [onSelectPlaylist]);

  return (
    <div className='pl-container'>
      <div className="pl-controls">
        <input
          type="text"
          value={filters.query}
          onChange={e => filterActions.setQuery(e.target.value)}
          placeholder={t('pl.search', 'Search playlists')}
          style={{
            flex: 1, 
            padding: '4px 6px', 
            borderRadius: 6, 
            border: '1px solid var(--border-subtle)', 
            background: 'rgba(255,255,255,0.05)', 
            color: 'inherit'
          }}
        />
        <button
          type="button"
          className="np-pill"
          aria-label={t('pl.filter.panel', 'Playlist filters')}
          aria-pressed={uiState.showFilters}
          onClick={() => uiActions.setShowFilters(!uiState.showFilters)}
          style={{
            flex: '0 0 30px', 
            width: 30, 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            padding: '4px 0', 
            position: 'relative'
          }}
          title={hasActiveFilters ? t('pl.filter.panel', 'Playlist filters') + ' *' : t('pl.filter.panel', 'Playlist filters')}
        >
          <span className="material-symbols-rounded filled" style={{fontSize: 18}}>filter_alt</span>
        </button>
      </div>
      {uiState.showFilters && (
        <div className="pl-filters-pop" role="dialog" aria-label={t('pl.filter.panel')}>
          <div className="pl-fp-head">
            <strong style={{fontSize: 12, letterSpacing: .5}}>{t('pl.filter.panel')}</strong>
            <button 
              type="button" 
              className="pl-fp-close" 
              aria-label={t('pl.close', 'Close')} 
              onClick={() => uiActions.setShowFilters(false)}
            >
              <span className="material-symbols-rounded" style={{fontSize: 18}}>close</span>
            </button>
          </div>
          <div className="pl-fp-sec">
            <div className="pl-fp-sec-title">{t('pl.order.section', 'Order')}</div>
            <div className="pl-order-row" style={{display: 'flex', gap: 6, width: '100%'}}>
              <select 
                value={filters.order} 
                onChange={e => filterActions.setOrder(e.target.value as FilterState['order'])} 
                aria-label={t('pl.order', 'Order')} 
                style={{flex: 1}}
              >
                <option value="name">{t('pl.order.name', 'Name')}</option>
                <option value="created">{t('pl.order.created', 'Created')}</option>
                <option value="tracks">{t('pl.order.tracks', 'Tracks')}</option>
              </select>
              <div style={{display: 'flex', gap: 4}}>
                <button 
                  type="button" 
                  className={`np-pill ${filters.orderDir === 'asc' ? 'active' : ''}`} 
                  onClick={() => filterActions.setOrderDir('asc')} 
                  aria-label={t('pl.order.asc', 'Ascending')} 
                  title={t('pl.order.asc', 'Ascending')} 
                  style={{padding: '6px 8px'}}
                >
                  <span className="material-symbols-rounded" style={{fontSize: 16}}>arrow_upward</span>
                </button>
                <button 
                  type="button" 
                  className={`np-pill ${filters.orderDir === 'desc' ? 'active' : ''}`} 
                  onClick={() => filterActions.setOrderDir('desc')} 
                  aria-label={t('pl.order.desc', 'Descending')} 
                  title={t('pl.order.desc', 'Descending')} 
                  style={{padding: '6px 8px'}}
                >
                  <span className="material-symbols-rounded" style={{fontSize: 16}}>arrow_downward</span>
                </button>
              </div>
            </div>
          </div>
          <div className="pl-fp-sec">
            <div className="pl-fp-sec-title">{t('pl.tags', 'Tags')}</div>
            <div className="pl-tags-row">
              <button 
                type="button" 
                className={`np-pill ${!filters.tagFilter ? 'active' : ''}`} 
                onClick={() => filterActions.setTagFilter('')}
              >
                {t('pl.filter.all', 'All')}
              </button>
              {derivedTags.map(tag => (
                <button 
                  key={tag} 
                  type="button" 
                  className={`np-pill ${filters.tagFilter === tag ? 'active' : ''}`} 
                  onClick={() => filterActions.setTagFilter(tag)}
                >
                  {tag}
                </button>
              ))}
              {!uiState.showAddTag && (
                <button 
                  type="button" 
                  className="np-pill pl-add" 
                  onClick={() => { uiActions.setShowAddTag(true); setTimeout(() => {}, 0); }} 
                  aria-label={t('pl.addTag', 'Add tag')} 
                  title={t('pl.addTag', 'Add tag')}
                >
                  <span className="material-symbols-rounded" style={{fontSize: 16, lineHeight: 1}}>add</span>
                </button>
              )}
              {uiState.showAddTag && (
                <div style={{display: 'flex', gap: 4, width: '100%'}}>
                  <input 
                    value={newTag} 
                    onChange={e => setNewTag(e.target.value)} 
                    placeholder={t('pl.newTag.placeholder', 'New tag name')} 
                    style={{flex: 1, minWidth: 0}} 
                    autoFocus 
                  />
                  <button 
                    type="button" 
                    className="np-pill" 
                    disabled={!newTag.trim()} 
                    onClick={handleAddTag}
                  >
                    {t('pl.add', 'Add')}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="pl-fp-sec">
            <div className="pl-fp-sec-title">{t('pl.view.section', 'View')}</div>
            <div className="pl-view-row">
              {VIEW_CONFIGS.map(def => (
                <button 
                  key={def.v} 
                  type="button" 
                  className={`np-pill ${filters.view === def.v ? 'active' : ''}`} 
                  onClick={() => filterActions.setView(def.v)} 
                  aria-label={t('pl.view.' + def.v, def.v)}
                >
                  <span className="material-symbols-rounded filled" style={{fontSize: 18}}>{def.icon}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className={`left-playlist ${gridClass}`} style={{ position: 'relative' }}>
        <div 
          className="pl-item pl-add" 
          style={{cursor: 'pointer', opacity: .9, borderStyle: 'dashed'}} 
          onClick={() => { if (!uiState.isCreating) uiActions.setIsCreating(true); }}
        >
          {!uiState.isCreating ? (
            <>
              <div 
                className="pl-thumb" 
                aria-hidden="true" 
                style={{
                  background: 'rgba(255,255,255,0.08)', 
                  color: 'var(--text)', 
                  fontWeight: 400, 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center'
                }}
              >
                <span className="material-symbols-rounded" style={{fontSize: 22}}>add</span>
              </div>
              <div className="pl-meta">
                <div className="pl-name overflow-ellipsis">{t('pl.new.item', 'New Playlist')}</div>
                <div className="pl-sub overflow-ellipsis">{t('pl.new.hint', 'Click to create')}</div>
              </div>
            </>
          ) : (
            <div 
              onClick={(e) => e.stopPropagation()} 
              style={{display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%'}}
            >
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={t('pl.new.placeholder', 'New playlist name')}
                className="add-to-playlist-create-input"
                style={{flex: 1}}
                onKeyDown={async (e) => { 
                  e.stopPropagation(); 
                  if (e.key === 'Enter') { 
                    await handleCreatePlaylist(); 
                  } else if (e.key === 'Escape') { 
                    handleResetCreate(e); 
                  } 
                }}
                autoFocus
              />
              <div style={{display: 'flex', gap: 6}}>
                <button 
                  type="button" 
                  className="np-pill create-confirm" 
                  onClick={async (e) => { 
                    e.stopPropagation(); 
                    await handleCreatePlaylist(); 
                  }} 
                  disabled={!newName.trim()} 
                  aria-disabled={!newName.trim()}
                >
                  {t('common.create', 'Create')}
                </button>
                <button 
                  type="button" 
                  className="np-pill create-cancel" 
                  onClick={(e) => { handleResetCreate(e); }}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
        {filteredPlaylists.map(p => {
          const pid = getPlaylistId(p);
          const isActive = activePlaylistId === pid;
          return (
            <div
              key={p.id}
              className={`pl-item ${p.system ? 'system' : ''} ${isActive ? 'active' : ''}`}
              title={p.name}
              role={onSelectPlaylist ? 'button' : undefined}
              tabIndex={onSelectPlaylist ? 0 : undefined}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => handleSelectPlaylist(pid)}
              onKeyDown={(e) => { 
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelectPlaylist(pid);
                }
              }}
            >
              <div className={`pl-thumb ${(p.system && p.code === 'favorites') ? "pl-favorites" : ""}`} aria-hidden="true">
                {p.system && p.code === 'favorites' ? (
                  <span className="material-symbols-rounded filled" style={{color: 'var(var(--glass-bg-strong2))'}}>star</span>
                ) : p.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="pl-meta">
                <div className="pl-name overflow-ellipsis">
                  {p.system && p.code === 'favorites' ? t('pl.favorites', 'Favorites') : p.name}
                </div>
                <div className="pl-sub overflow-ellipsis">
                  {(p.track_count || 0)} {t('pl.tracks', 'tracks')}
                  {p.tags.length ? ' · ' + p.tags.join(', ') : ''}
                </div>
              </div>
            </div>
          );
        })}
        {!filteredPlaylists.length && (
          <div style={{opacity: 0.65, fontSize: 12, margin: '12px 0'}}>
            {t('pl.empty', 'No playlists')}
          </div>
        )}
      </div>
    </div>
  );
});

LeftPanelPlaylists.displayName = 'LeftPanelPlaylists';

export default LeftPanelPlaylists;
