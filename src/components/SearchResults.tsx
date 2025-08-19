import React from 'react'
import { useI18n } from '../core/i18n'

export default function SearchResults({ query }: { query?: string }){
  const { t } = useI18n();
  return (
    <section className="search-results">
      <h3>{t('search.results')}</h3>
      <div>{query ? t('search.resultsFor', undefined, { query }) : t('search.resultsEmpty')}</div>
    </section>
  )
}
