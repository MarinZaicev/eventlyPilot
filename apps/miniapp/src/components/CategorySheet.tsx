import {
  Check,
  X,
} from 'lucide-react'

import type {
  ApiCategory,
} from '../lib/profile'

type Props = {
  categories: ApiCategory[]
  preferredCategories: string[]
  activeCategory: string | null

  onSelect: (
    category: string,
  ) => void

  onClose: () => void
}

export function CategorySheet({
  categories,
  preferredCategories,
  activeCategory,
  onSelect,
  onClose,
}: Props) {
  const preferred =
    categories.filter(
      (category) =>
        preferredCategories.includes(
          category.slug,
        ),
    )

  const other =
    categories.filter(
      (category) =>
        !preferredCategories.includes(
          category.slug,
        ),
    )

  function renderCategory(
    category: ApiCategory,
  ) {
    const active =
      activeCategory ===
      category.slug

    return (
      <button
        key={category.id}
        type="button"
        className={
          active
            ? 'category-sheet-card active'
            : 'category-sheet-card'
        }
        onClick={() =>
          onSelect(
            category.slug,
          )
        }
      >
        <span className="category-sheet-icon">
          {category.icon ?? '✦'}
        </span>

        <span className="category-sheet-name">
          {category.name}
        </span>

        {active && (
          <span className="category-sheet-check">
            <Check size={13} />
          </span>
        )}
      </button>
    )
  }

  return (
    <div
      className="category-sheet-backdrop"
      onClick={onClose}
    >
      <div
        className="category-sheet"
        onClick={(event) =>
          event.stopPropagation()
        }
      >
        <div className="category-sheet-handle" />

        <div className="category-sheet-header">
          <div>
            <h2>
              Куда пойдём?
            </h2>

            <p>
              Выбери, что хочется
              посмотреть сейчас
            </p>
          </div>

          <button
            type="button"
            className="category-sheet-close"
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </div>

        {preferred.length > 0 && (
          <section className="category-section">
            <div className="category-section-title">
              Твои интересы
            </div>

            <div className="category-sheet-grid">
              {preferred.map(
                renderCategory,
              )}
            </div>
          </section>
        )}

        {other.length > 0 && (
          <section className="category-section">
            <div className="category-section-title">
              Все категории
            </div>

            <div className="category-sheet-grid">
              {other.map(
                renderCategory,
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
