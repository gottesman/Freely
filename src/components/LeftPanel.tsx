import React from 'react'
import { useI18n } from '../core/i18n'
import { usePlaylists } from '../core/playlists'

export default function LeftPanel({ collapsed, onToggle, width, extraClass }: { collapsed: boolean, onToggle: () => void, width?: number, extraClass?: string }){
  const { t } = useI18n();
  const { playlists, createPlaylist, deletePlaylist } = usePlaylists();
  const [query, setQuery] = React.useState('');
  const [tagFilter, setTagFilter] = React.useState<string>('');
  const [order, setOrder] = React.useState<'name'|'created'|'tracks'>('name');
  const [orderDir, setOrderDir] = React.useState<'asc'|'desc'>('asc');
  const [view, setView] = React.useState<'compact'|'list'|'sm-grid'|'lg-grid'>('list');
  const [newName, setNewName] = React.useState('');
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
      let cmp = 0;
      if(order==='name') cmp = a.name.localeCompare(b.name);
      else if(order==='created') cmp = (a.created_at||0) - (b.created_at||0);
      else if(order==='tracks') cmp = (a.track_count||0) - (b.track_count||0);
      return orderDir==='asc' ? cmp : -cmp;
    });
  const onCreate = ()=>{ if(newName.trim()) { createPlaylist(newName.trim()); setNewName(''); } };
  const gridClass = view==='sm-grid' ? 'pl-grid sm' : view==='lg-grid' ? 'pl-grid lg' : view==='compact' ? 'pl-list compact' : 'pl-list';
  const hasActiveFilters = !!tagFilter || order !== 'name' || orderDir !== 'asc' || view !== 'list';

  if (collapsed) {
    return (
      <aside className={`main-panels left-panel collapsed ${extraClass||''}`}>
        <div className="panel-header">
          <button
            type="button"
            className="panel-collapse-toggle left-panel-toggle"
            onClick={onToggle}
            aria-label={t('panel.expand','Expand')}
            title={t('panel.expand','Expand')}>
            <span className="material-symbols-rounded" style={{fontSize:20}}>left_panel_open</span>
          </button>
        </div>
        <div className="collapsed-thumb-list">
          {filtered.map(p => (
            <div key={p.id} className="collapsed-thumb-item" title={p.name}>
              <div className="collapsed-thumb" aria-hidden="true">{p.name.slice(0,2).toUpperCase()}</div>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
  <aside className={`main-panels left-panel ${extraClass||''}`} style={width ? { width } : undefined}>
      <nav className="left-nav">
        <div className="panel-header">
          <h4 className="panel-title" style={{margin:0}}>{t('left.collections','Collections')}</h4>
          <button
            type="button"
            className="panel-collapse-toggle left-panel-toggle"
            onClick={onToggle}
            aria-label={t('panel.collapse','Collapse')}
            title={t('panel.collapse','Collapse')}>
            <span className="material-symbols-rounded" style={{fontSize:20}}>left_panel_close</span>
          </button>
        </div>
        <div className="pl-controls" style={{display:'flex', gap:6, alignItems:'center', marginBottom:10}}>
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
            style={{flex:'0 0 38px', width:38, display:'flex', alignItems:'center', justifyContent:'center', padding:'6px 0', position:'relative'}}
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
                  <button type="button" className="np-pill" onClick={()=> { setShowAddTag(true); setTimeout(()=>{ /* focus handled below via ref */ },0); }} aria-label={t('pl.addTag','Add tag')} title={t('pl.addTag','Add tag')}>
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
  <div className={`pl-container ${gridClass}`} style={{ position:'relative' }}>
          {/* New playlist pseudo-item */}
          <div className="pl-item" onClick={()=>{ if(!newName.trim()){ setNewName(''); const name = prompt(t('pl.new.placeholder','New playlist name')) || ''; if(name.trim()){ createPlaylist(name.trim()); } } else { onCreate(); } }} style={{cursor:'pointer', opacity:.9, borderStyle:'dashed'}}>
            <div className="pl-thumb" aria-hidden="true" style={{background:'rgba(255,255,255,0.08)', color:'var(--text)', fontWeight:400, display:'flex', alignItems:'center', justifyContent:'center'}}>
              <span className="material-symbols-rounded" style={{fontSize:22}}>add</span>
            </div>
            <div className="pl-meta">
              <div className="pl-name">{t('pl.new.item','New Playlist')}</div>
              <div className="pl-sub">{t('pl.new.hint','Click to create')}</div>
            </div>
          </div>
          {filtered.map(p => (
            <div key={p.id} className="pl-item" title={p.name}>
              <div className="pl-thumb" aria-hidden="true">{p.name.slice(0,2).toUpperCase()}</div>
              <div className="pl-meta">
                <div className="pl-name">{p.name}</div>
                <div className="pl-sub">{(p.track_count||0)} · {p.tags.join(', ')}</div>
              </div>
              <button className="pl-del" aria-label={t('pl.delete','Delete')} onClick={()=> deletePlaylist(p.id)}>×</button>
            </div>
          ))}
          {!filtered.length && <div style={{opacity:0.65, fontSize:12}}>{t('pl.empty','No playlists')}</div>}
        </div>
      </nav>
    </aside>
  )
}
