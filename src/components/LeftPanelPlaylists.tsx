import React from 'react';
import { useI18n } from '../core/i18n';
import { usePlaylists } from '../core/playlists';

export interface LeftPanelPlaylistsProps {
  onSelectPlaylist?: (id: string) => void;
  activePlaylistId?: string;
}

export default function LeftPanelPlaylists({ onSelectPlaylist, activePlaylistId }: LeftPanelPlaylistsProps){
  const { t } = useI18n();
  const { playlists, createPlaylist } = usePlaylists();

  const [query, setQuery] = React.useState('');
  const [tagFilter, setTagFilter] = React.useState<string>('');
  const [order, setOrder] = React.useState<'name'|'created'|'tracks'>('name');
  const [orderDir, setOrderDir] = React.useState<'asc'|'desc'>('asc');
  const [view, setView] = React.useState<'compact'|'list'|'sm-grid'|'lg-grid'>('list');
  const [newName, setNewName] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [showFilters, setShowFilters] = React.useState(false);
  const [newTag, setNewTag] = React.useState('');
  const [showAddTag, setShowAddTag] = React.useState(false);
  const [extraTags, setExtraTags] = React.useState<string[]>([]);

  const derivedTags = React.useMemo(()=>{
    const set = new Set<string>();
    playlists.forEach(p=> p.tags.forEach(t=> set.add(t)));
    extraTags.forEach(t=> set.add(t));
    return Array.from(set).sort();
  }, [playlists, extraTags]);

  const filtered = playlists
    .filter(p => !query || p.name.toLowerCase().includes(query.toLowerCase()))
    .filter(p => !tagFilter || p.tags.includes(tagFilter))
    .sort((a,b)=>{
      const aFav = a.system && a.code === 'favorites';
      const bFav = b.system && b.code === 'favorites';
      if(aFav && !bFav) return -1;
      if(bFav && !aFav) return 1;
      let cmp = 0;
      if(order==='name') cmp = a.name.localeCompare(b.name);
      else if(order==='created') cmp = (a.created_at||0) - (b.created_at||0);
      else if(order==='tracks') cmp = (a.track_count||0) - (b.track_count||0);
      return orderDir==='asc' ? cmp : -cmp;
    });

  const onCreate = async (e: any) => {
    const name = newName.trim();
    if(!name) return;
  await createPlaylist(name);
  try { resetCreate(undefined); } catch(err) {console.error(err)}
  setTagFilter('');
  setQuery(q=> q ? '' : q);
  };

  const resetCreate = (e: any) => {
    try { if(e && typeof e.stopPropagation === 'function') e.stopPropagation(); } catch(_) {}
    setNewName('');
    setIsCreating(false);
  };

  const gridClass = view==='sm-grid' ? 'pl-grid sm' : view==='lg-grid' ? 'pl-grid lg' : view==='compact' ? 'pl-list compact' : 'pl-list';
  const hasActiveFilters = !!tagFilter || order !== 'name' || orderDir !== 'asc' || view !== 'list';

  return (
    <div className='pl-container'>
      <div className="pl-controls">
        <input
          type="text"
          value={query}
          onChange={e=>setQuery(e.target.value)}
          placeholder={t('pl.search','Search playlists')}
          style={{flex:1, padding:'4px 6px', borderRadius:6, border:'1px solid var(--border-subtle)', background:'rgba(255,255,255,0.05)', color:'inherit'}}
        />
        <button
          type="button"
          className="np-pill"
          aria-label={t('pl.filter.panel','Playlist filters')}
          aria-pressed={showFilters}
          onClick={()=> setShowFilters(s=>!s)}
          style={{flex:'0 0 30px', width:30, display:'flex', alignItems:'center', justifyContent:'center', padding:'4px 0', position:'relative'}}
          title={hasActiveFilters ? t('pl.filter.panel','Playlist filters') + ' *' : t('pl.filter.panel','Playlist filters')}
        >
          <span className="material-symbols-rounded filled" style={{fontSize:18}}>filter_alt</span>
        </button>
      </div>
      {showFilters && (
        <div className="pl-filters-pop" role="dialog" aria-label={t('pl.filter.panel')}>
          <div className="pl-fp-head">
            <strong style={{fontSize:12, letterSpacing:.5}}>{t('pl.filter.panel')}</strong>
            <button type="button" className="pl-fp-close" aria-label={t('pl.close','Close')} onClick={()=> setShowFilters(false)}><span className="material-symbols-rounded" style={{fontSize:18}}>close</span></button>
          </div>
          <div className="pl-fp-sec">
            <div className="pl-fp-sec-title">{t('pl.order.section','Order')}</div>
            <div className="pl-order-row" style={{display:'flex', gap:6, width:'100%'}}>
              <select value={order} onChange={e=>setOrder(e.target.value as any)} aria-label={t('pl.order','Order')} style={{flex:1}}>
                <option value="name">{t('pl.order.name','Name')}</option>
                <option value="created">{t('pl.order.created','Created')}</option>
                <option value="tracks">{t('pl.order.tracks','Tracks')}</option>
              </select>
              <div style={{display:'flex', gap:4}}>
                <button type="button" className={`np-pill ${orderDir==='asc'?'active':''}`} onClick={()=> setOrderDir('asc')} aria-label={t('pl.order.asc','Ascending')} title={t('pl.order.asc','Ascending')} style={{padding:'6px 8px'}}>
                  <span className="material-symbols-rounded" style={{fontSize:16}}>arrow_upward</span>
                </button>
                <button type="button" className={`np-pill ${orderDir==='desc'?'active':''}`} onClick={()=> setOrderDir('desc')} aria-label={t('pl.order.desc','Descending')} title={t('pl.order.desc','Descending')} style={{padding:'6px 8px'}}>
                  <span className="material-symbols-rounded" style={{fontSize:16}}>arrow_downward</span>
                </button>
              </div>
            </div>
          </div>
          <div className="pl-fp-sec">
            <div className="pl-fp-sec-title">{t('pl.tags','Tags')}</div>
            <div className="pl-tags-row">
              <button type="button" className={`np-pill ${!tagFilter?'active':''}`} onClick={()=> setTagFilter('')}>{t('pl.filter.all','All')}</button>
              {derivedTags.map(tag => (
                <button key={tag} type="button" className={`np-pill ${tagFilter===tag?'active':''}`} onClick={()=> setTagFilter(tag)}>{tag}</button>
              ))}
              {!showAddTag && (
                <button type="button" className="np-pill pl-add" onClick={()=> { setShowAddTag(true); setTimeout(()=>{},0); }} aria-label={t('pl.addTag','Add tag')} title={t('pl.addTag','Add tag')}>
                  <span className="material-symbols-rounded" style={{fontSize:16, lineHeight:1}}>add</span>
                </button>
              )}
              {showAddTag && (
                <div style={{display:'flex', gap:4, width:'100%'}}>
                  <input value={newTag} onChange={e=>setNewTag(e.target.value)} placeholder={t('pl.newTag.placeholder','New tag name')} style={{flex:1, minWidth:0}} autoFocus />
                  <button type="button" className="np-pill" disabled={!newTag.trim()} onClick={()=>{ const val=newTag.trim(); if(val && !derivedTags.includes(val)){ setExtraTags(list=> [...list, val]); setTagFilter(val); } setNewTag(''); setShowAddTag(false); }}>{t('pl.add','Add')}</button>
                </div>
              )}
            </div>
          </div>
          <div className="pl-fp-sec">
            <div className="pl-fp-sec-title">{t('pl.view.section','View')}</div>
            <div className="pl-view-row">
              {([
                {v:'compact', icon:'view_headline'},
                {v:'list', icon:'view_list'},
                {v:'sm-grid', icon:'view_module'},
                {v:'lg-grid', icon:'view_cozy'}
              ] as const).map(def => (
                <button key={def.v} type="button" className={`np-pill ${view===def.v?'active':''}`} onClick={()=> setView(def.v as any)} aria-label={t('pl.view.'+def.v, def.v)}>
                  <span className="material-symbols-rounded filled" style={{fontSize:18}}>{def.icon}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className={`left-playlist ${gridClass}`} style={{ position:'relative' }}>
        <div className="pl-item pl-add" style={{cursor:'pointer', opacity:.9, borderStyle:'dashed'}} onClick={()=>{ if(!isCreating) setIsCreating(true); }}>
          {!isCreating ? (
            <>
              <div className="pl-thumb" aria-hidden="true" style={{background:'rgba(255,255,255,0.08)', color:'var(--text)', fontWeight:400, display:'flex', alignItems:'center', justifyContent:'center'}}>
                <span className="material-symbols-rounded" style={{fontSize:22}}>add</span>
              </div>
              <div className="pl-meta">
                <div className="pl-name overflow-ellipsis">{t('pl.new.item','New Playlist')}</div>
                <div className="pl-sub overflow-ellipsis">{t('pl.new.hint','Click to create')}</div>
              </div>
            </>
          ) : (
            <div onClick={(e)=>e.stopPropagation()} style={{display:'flex', flexDirection: 'column', alignItems:'center', width:'100%'}}>
              <input
                type="text"
                value={newName}
                onChange={e=>setNewName(e.target.value)}
                placeholder={t('pl.new.placeholder','New playlist name')}
                className="add-to-playlist-create-input"
                style={{flex:1}}
                onKeyDown={async (e)=>{ e.stopPropagation(); if(e.key==='Enter'){ await onCreate(e); } else if(e.key==='Escape'){ resetCreate(e); } }}
                autoFocus
              />
              <div style={{display:'flex', gap:6}}>
                <button type="button" className="np-pill create-confirm" onClick={async (e)=>{ e.stopPropagation(); await onCreate(e); }} disabled={!newName.trim()} aria-disabled={!newName.trim()}>{t('common.create','Create')}</button>
                <button type="button" className="np-pill create-cancel" onClick={(e)=>{ resetCreate(e); }}>{t('common.cancel','Cancel')}</button>
              </div>
            </div>
          )}
        </div>
        {filtered.map(p => {
          const pid = (p.system && p.code==='favorites') ? 'favorites' : ('local:'+p.id);
          const isActive = activePlaylistId === pid;
          return (
            <div
              key={p.id}
              className={`pl-item ${p.system? 'system':''} ${isActive? 'active':''}`}
              title={p.name}
              role={onSelectPlaylist ? 'button' : undefined}
              tabIndex={onSelectPlaylist ? 0 : undefined}
              aria-current={isActive? 'true': undefined}
              onClick={()=> { if(onSelectPlaylist){ onSelectPlaylist(pid);} }}
              onKeyDown={(e)=> { if(!onSelectPlaylist) return; if(e.key==='Enter' || e.key===' '){ e.preventDefault(); onSelectPlaylist(pid);} }}
            >
              <div className={`pl-thumb ${(p.system && p.code==='favorites')?"pl-favorites" : ""}`} aria-hidden="true">
                {p.system && p.code==='favorites' ? (
                  <span className="material-symbols-rounded filled" style={{color:'var(var(--glass-bg-strong2))'}}>star</span>
                ) : p.name.slice(0,2).toUpperCase()}
              </div>
              <div className="pl-meta">
                <div className="pl-name overflow-ellipsis">{p.system && p.code==='favorites' ? t('pl.favorites','Favorites') : p.name}</div>
                <div className="pl-sub overflow-ellipsis">{(p.track_count||0)} {t('pl.tracks','tracks')}{p.tags.length ? ' · ' + p.tags.join(', ') : ''}</div>
              </div>
            </div>
          );
        })}
        {!filtered.length && <div style={{opacity:0.65, fontSize:12, margin: '12px 0'}}>{t('pl.empty','No playlists')}</div>}
      </div>
    </div>
  );
}
