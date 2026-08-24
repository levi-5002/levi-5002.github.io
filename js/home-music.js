(() => {
  'use strict'

  const config = window.HOME_MUSIC_CONFIG
  if (!config || !config.enabled || !config.audio) return

  const stateKey = `home-music-state:${config.audio}`
  const resumeKey = `home-music-resume:${config.audio}`
  const homePath = normalizePath(config.homePath || '/')

  let container
  let audio
  let restored = false
  let routePause = false
  let navigationPending = false
  let lastKnownTime = 0
  let lastSavedAt = 0
  let playbackVolume = Number.isFinite(config.volume)
    ? Math.min(1, Math.max(0, config.volume))
    : 1
  let fadeInTimer
  let fadeInToken = 0
  let fadingIn = false
  let fadeOutTimer
  let fadeStartVolume
  let fadeToken = 0
  let fadingOut = false

  function normalizePath (path) {
    const normalized = path.replace(/\/+$/, '')
    return normalized || '/'
  }

  function isHomePage () {
    return normalizePath(window.location.pathname) === homePath && Boolean(document.querySelector('#recent-posts'))
  }

  function readState () {
    try {
      return JSON.parse(window.localStorage.getItem(stateKey))
    } catch (error) {
      return null
    }
  }

  function saveState (force = false) {
    if (!audio) return

    if (!navigationPending && Number.isFinite(audio.currentTime)) {
      lastKnownTime = audio.currentTime
    }

    const now = Date.now()
    if (!force && now - lastSavedAt < 1000) return
    lastSavedAt = now

    try {
      window.localStorage.setItem(stateKey, JSON.stringify({
        currentTime: lastKnownTime,
        volume: playbackVolume,
        configuredVolume: config.volume,
        savedAt: now
      }))
    } catch (error) {
      console.warn('Unable to save home music progress.', error)
    }
  }

  function setShouldResume (value) {
    try {
      window.sessionStorage.setItem(resumeKey, value ? '1' : '0')
    } catch (error) {
      // Playback still works when browser storage is unavailable.
    }
  }

  function shouldResume () {
    try {
      return window.sessionStorage.getItem(resumeKey) === '1'
    } catch (error) {
      return false
    }
  }

  async function tryPlayback () {
    if (!audio || !isHomePage()) return

    audio.muted = false
    setShouldResume(true)
    cancelFadeOut()
    startFadeIn()

    try {
      await audio.play()
    } catch (error) {
      cancelFadeIn(true)
      // Browsers may require the visitor to press play once.
    }
  }

  function restoreState () {
    if (restored || !audio || !Number.isFinite(audio.duration)) return
    restored = true

    const state = readState()
    if (state) {
      if (Number.isFinite(state.currentTime) && state.currentTime < audio.duration - 1) {
        lastKnownTime = Math.max(0, state.currentTime)
      }

      if (Number.isFinite(state.volume) && state.configuredVolume === config.volume) {
        playbackVolume = Math.min(1, Math.max(0, state.volume))
      } else if (Number.isFinite(config.volume)) {
        playbackVolume = Math.min(1, Math.max(0, config.volume))
      }

      if (lastKnownTime > 0) {
        audio.currentTime = lastKnownTime
      }
    } else if (Number.isFinite(config.volume)) {
      playbackVolume = Math.min(1, Math.max(0, config.volume))
    }
    audio.volume = playbackVolume
    audio.muted = false

    container.hidden = !isHomePage()
    const firstVisit = !state
    if (isHomePage() && (shouldResume() || (config.autoplay && firstVisit))) tryPlayback()
  }

  function createTextBlock () {
    const info = document.createElement('div')
    info.className = 'home-music-player__info'

    const title = document.createElement('strong')
    title.className = 'home-music-player__title'
    title.textContent = config.title || '背景音乐'
    info.appendChild(title)

    if (config.artist) {
      const artist = document.createElement('span')
      artist.className = 'home-music-player__artist'
      artist.textContent = config.artist
      info.appendChild(artist)
    }

    return info
  }

  function createPlayer () {
    if (container) return

    container = document.createElement('section')
    container.id = 'home-music-player'
    container.className = 'home-music-player'
    container.setAttribute('aria-label', config.title || '背景音乐')
    container.hidden = true

    if (config.cover) {
      const cover = document.createElement('img')
      cover.className = 'home-music-player__cover'
      cover.src = config.cover
      cover.alt = ''
      container.appendChild(cover)
    } else {
      container.classList.add('home-music-player--no-cover')
    }

    container.appendChild(createTextBlock())

    audio = document.createElement('audio')
    audio.className = 'home-music-player__audio'
    audio.volume = playbackVolume
    audio.src = config.audio
    audio.controls = true
    audio.autoplay = Boolean(config.autoplay)
    audio.muted = false
    audio.preload = 'metadata'

    audio.addEventListener('loadedmetadata', restoreState)
    audio.addEventListener('timeupdate', () => saveState())
    audio.addEventListener('seeked', () => saveState(true))
    audio.addEventListener('volumechange', () => {
      if (!fadingIn && !fadingOut) {
        playbackVolume = audio.volume
        saveState(true)
      }
    })
    audio.addEventListener('play', () => {
      navigationPending = false
      setShouldResume(true)
      if (!fadingIn && isHomePage()) startFadeIn()
    })
    audio.addEventListener('pause', () => {
      if (!routePause && !navigationPending && document.visibilityState === 'visible') {
        cancelFadeIn(true)
        setShouldResume(false)
      }
    })
    audio.addEventListener('ended', () => {
      audio.currentTime = 0
      saveState(true)
      setShouldResume(false)
    })
    audio.addEventListener('error', () => {
      container.hidden = true
      console.warn(`Home music could not be loaded: ${config.audio}`)
    })

    container.appendChild(audio)
    document.body.appendChild(container)

    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: config.title || '背景音乐',
        artist: config.artist || '',
        artwork: config.cover ? [{ src: config.cover }] : []
      })
    }
  }

  function cancelFadeIn (restoreVolume = false) {
    if (!fadingIn) return

    fadeInToken += 1
    if (fadeInTimer) clearInterval(fadeInTimer)
    if (restoreVolume) {
      audio.muted = false
      audio.volume = playbackVolume
    }

    fadeInTimer = undefined
    fadingIn = false
  }

  function startFadeIn () {
    if (!audio || fadingIn) return

    const duration = Number.isFinite(config.fadeInDuration)
      ? Math.max(0, config.fadeInDuration)
      : 1000

    const token = ++fadeInToken
    const startedAt = Date.now()
    fadingIn = true
    audio.muted = false
    audio.volume = Math.min(playbackVolume, 0.0001)

    const finish = () => {
      if (token !== fadeInToken) return

      if (fadeInTimer) clearInterval(fadeInTimer)
      audio.muted = false
      audio.volume = playbackVolume
      fadeInTimer = undefined
      fadingIn = false
    }

    if (duration === 0 || playbackVolume === 0) {
      finish()
      return
    }

    const step = () => {
      if (token !== fadeInToken) return

      const progress = Math.min(1, (Date.now() - startedAt) / duration)
      audio.volume = playbackVolume * progress

      if (progress >= 1) finish()
    }

    fadeInTimer = setInterval(step, 25)
    step()
  }

  function cancelFadeOut () {
    if (!fadingOut) return

    fadeToken += 1
    if (fadeOutTimer) clearInterval(fadeOutTimer)
    if (Number.isFinite(fadeStartVolume)) audio.volume = fadeStartVolume

    fadeOutTimer = undefined
    fadeStartVolume = undefined
    fadingOut = false
  }

  function fadeOutAndPause () {
    if (!audio || audio.paused || fadingOut) return

    cancelFadeIn(false)

    const duration = Number.isFinite(config.fadeOutDuration)
      ? Math.max(0, config.fadeOutDuration)
      : 1000

    fadeStartVolume = audio.volume
    fadingOut = true
    const token = ++fadeToken
    const startedAt = Date.now()

    const finish = () => {
      if (token !== fadeToken) return

      if (fadeOutTimer) clearInterval(fadeOutTimer)
      routePause = true
      audio.pause()
      audio.muted = false
      audio.volume = playbackVolume
      routePause = false

      fadeOutTimer = undefined
      fadeStartVolume = undefined
      fadingOut = false
    }

    if (duration === 0 || fadeStartVolume === 0) {
      finish()
      return
    }

    const step = () => {
      if (token !== fadeToken) return

      const progress = Math.min(1, (Date.now() - startedAt) / duration)
      audio.volume = fadeStartVolume * (1 - progress)

      if (progress >= 1) finish()
    }

    fadeOutTimer = setInterval(step, 25)
    step()
  }

  function pauseForNavigation () {
    if (!audio) return

    const wasPlaying = !audio.paused && !audio.ended
    if (wasPlaying) setShouldResume(true)
    saveState(true)
    navigationPending = true

    if (wasPlaying) fadeOutAndPause()
  }

  function syncPlayerWithPage () {
    if (isHomePage()) {
      navigationPending = false
      createPlayer()
      cancelFadeOut()
      audio.muted = false
      if (restored) {
        container.hidden = false
        if (shouldResume()) tryPlayback()
      }
      return
    }

    if (audio && !audio.paused && !fadingOut) pauseForNavigation()
    if (container) container.hidden = true
  }

  document.addEventListener('DOMContentLoaded', syncPlayerWithPage)
  document.addEventListener('pjax:send', pauseForNavigation)
  document.addEventListener('pjax:complete', syncPlayerWithPage)
  const unlockPlayback = () => {
    if (audio && audio.paused && isHomePage() && shouldResume()) tryPlayback()
  }
  document.addEventListener('pointerdown', unlockPlayback, true)
  document.addEventListener('keydown', unlockPlayback, true)
  document.addEventListener('touchstart', unlockPlayback, true)
  window.addEventListener('beforeunload', () => {
    if (!audio) return
    if (!audio.paused && !audio.ended) setShouldResume(true)
    saveState(true)
    navigationPending = true
  })
  window.addEventListener('pagehide', () => {
    if (!audio) return
    if (!audio.paused && !audio.ended) setShouldResume(true)
    saveState(true)
    navigationPending = true
  })
  window.addEventListener('pageshow', syncPlayerWithPage)
})()
