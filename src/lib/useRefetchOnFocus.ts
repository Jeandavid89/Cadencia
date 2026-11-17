import { useEffect, useRef } from 'react'

/**
 * Relance `reload` quand l'onglet redevient visible (retour depuis une
 * autre fenetre/application, ou depuis un autre onglet) - pour refleter
 * les modifications faites entre-temps sur un autre ordinateur, sans aller
 * jusqu'au vrai temps reel (retour utilisateur du 17/11 : "voir en direct
 * les modifications faites sur un autre ordi"). Les retours rapproches
 * (< minIntervalMs) sont ignores pour eviter les rechargements en rafale.
 */
export function useRefetchOnFocus(reload: () => void, minIntervalMs = 3000): void {
  const lastRun = useRef(0)
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRun.current < minIntervalMs) return
      lastRun.current = now
      reloadRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [minIntervalMs])
}
