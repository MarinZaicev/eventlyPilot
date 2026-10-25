import {
  useMemo,
  useState,
} from 'react'

import {
  ArrowRight,
  Check,
  Sparkles,
  X,
} from 'lucide-react'

import type {
  ApiCategory,
} from '../lib/profile'

type Props = {
  categories: ApiCategory[]
  onComplete: (
    selected: string[],
  ) => Promise<void>

  // Режим «Изменить интересы» из профиля:
  // уже выбранные темы и кнопка закрытия.
  initialSelected?: string[]
  onCancel?: () => void
}

export function Onboarding({
  categories,
  onComplete,
  initialSelected,
  onCancel,
}: Props) {
  const editing = Boolean(onCancel)

  const [selected, setSelected] =
    useState<string[]>(
      initialSelected ?? [],
    )

  const [error, setError] =
    useState(false)

  const [saving, setSaving] =
    useState(false)

  const selectedSet =
    useMemo(
      () => new Set(selected),
      [selected],
    )

  function toggleCategory(
    slug: string,
  ) {
    setSelected((current) => {
      if (current.includes(slug)) {
        return current.filter(
          (item) => item !== slug,
        )
      }

      return [...current, slug]
    })
  }

  async function submit() {
    if (
      selected.length < 3 ||
      saving
    ) {
      return
    }

    setSaving(true)
    setError(false)

    try {
      await onComplete(selected)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-glow onboarding-glow-one" />
      <div className="onboarding-glow onboarding-glow-two" />

      <div className="onboarding-content">
        <div className="onboarding-brand">
          <Sparkles size={18} />
          <span>EVENTLY</span>

          {onCancel && (
            <button
              type="button"
              className="onboarding-close"
              aria-label="Закрыть"
              onClick={onCancel}
            >
              <X size={20} />
            </button>
          )}
        </div>

        <div className="onboarding-heading">
          {editing ? (
            <>
              <h1>
                Твои
                <br />
                интересы
              </h1>

              <p>
                Отметь темы, которые
                хочешь видеть. Лента
                пересоберётся под новый
                выбор, а то, что ты уже
                лайкал, никуда не денется.
              </p>
            </>
          ) : (
            <>
              <h1>
                Что тебе
                <br />
                нравится?
              </h1>

              <p>
                Выбери хотя бы 3 темы.
                Мы соберём первую ленту,
                а дальше она сама
                подстроится под тебя.
              </p>
            </>
          )}
        </div>

        <div className="interest-grid">
          {categories.map(
            (category) => {
              const active =
                selectedSet.has(
                  category.slug,
                )

              return (
                <button
                  key={category.id}
                  type="button"
                  className={
                    active
                      ? 'interest-card active'
                      : 'interest-card'
                  }
                  onClick={() =>
                    toggleCategory(
                      category.slug,
                    )
                  }
                >
                  <span className="interest-icon">
                    {category.icon ?? '✦'}
                  </span>

                  <span className="interest-name">
                    {category.name}
                  </span>

                  <span className="interest-check">
                    {active && (
                      <Check size={14} />
                    )}
                  </span>
                </button>
              )
            },
          )}
        </div>

        <div className="onboarding-footer">
          <div className="selection-counter">
            {error
              ? 'Не получилось сохранить, попробуй ещё раз'
              : selected.length < 3
              ? `Выбери ещё ${
                  3 - selected.length
                }`
              : `Выбрано: ${selected.length}`}
          </div>

          <button
            className="onboarding-submit"
            type="button"
            disabled={
              selected.length < 3 ||
              saving
            }
            onClick={() =>
              void submit()
            }
          >
            <span>
              {saving
                ? 'Сохраняем...'
                : editing
                  ? 'Сохранить и обновить ленту'
                  : 'Собрать мою ленту'}
            </span>

            {!saving && (
              <ArrowRight size={20} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
