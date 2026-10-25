import {
  useEffect,
  useRef,
} from 'react'

import {
  sendInteraction,
} from '../lib/interactions'

export function useEventView(
  eventId: string,
  position: number,
) {
  const elementRef =
    useRef<HTMLElement | null>(null)

  const viewStartedAt =
    useRef<number | null>(null)

  const impressionSent =
    useRef(false)

  useEffect(() => {
    const element = elementRef.current

    if (!element) {
      return
    }

    function finishView() {
      if (viewStartedAt.current === null) {
        return
      }

      const durationMs = Math.round(
        performance.now() -
          viewStartedAt.current,
      )

      viewStartedAt.current = null

      // Микросвайпы нам почти ничего не дают.
      if (durationMs < 500) {
        return
      }

      void sendInteraction(
        eventId,
        'DWELL',
        {
          durationMs,

          metadata: {
            position,
            feed: 'for-you',
          },
        },
      )
    }

    const observer =
      new IntersectionObserver(
        ([entry]) => {
          if (
            entry.isIntersecting &&
            entry.intersectionRatio >= 0.65
          ) {
            if (
              viewStartedAt.current === null
            ) {
              viewStartedAt.current =
                performance.now()
            }

            if (!impressionSent.current) {
              impressionSent.current = true

              void sendInteraction(
                eventId,
                'IMPRESSION',
                {
                  metadata: {
                    position,
                    feed: 'for-you',
                  },
                },
              )
            }

            return
          }

          finishView()
        },
        {
          threshold: [0, 0.65, 1],
        },
      )

    observer.observe(element)

    return () => {
      finishView()
      observer.disconnect()
    }
  }, [eventId, position])

  return elementRef
}
