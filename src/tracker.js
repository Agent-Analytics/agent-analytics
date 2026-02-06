/**
 * Embedded tracker.js - client-side analytics snippet
 * Served as plain JavaScript from GET /tracker.js
 */
export const TRACKER_JS = `
(function() {
  'use strict';
  
  const ENDPOINT = (document.currentScript && document.currentScript.src) 
    ? new URL(document.currentScript.src).origin + '/track'
    : '/track';
  
  const PROJECT = (document.currentScript && document.currentScript.dataset.project) || 'default';
  
  // Simple fingerprint for anonymous users
  function getAnonId() {
    let id = localStorage.getItem('aa_uid');
    if (!id) {
      id = 'anon_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('aa_uid', id);
    }
    return id;
  }
  
  let userId = getAnonId();
  
  const aa = {
    track: function(event, properties) {
      const payload = {
        project: PROJECT,
        event: event,
        properties: {
          ...properties,
          url: location.href,
          referrer: document.referrer,
          screen: screen.width + 'x' + screen.height,
        },
        user_id: userId,
        timestamp: Date.now()
      };
      
      // Use sendBeacon for reliability, fallback to fetch
      const data = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, data);
      } else {
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data,
          keepalive: true
        }).catch(() => {});
      }
    },
    
    identify: function(id) {
      userId = id;
      localStorage.setItem('aa_uid', id);
    },
    
    page: function(name) {
      this.track('page_view', { page: name || document.title, path: location.pathname });
    }
  };
  
  // Auto track page view
  aa.page();
  
  // Expose globally
  window.aa = aa;
})();
`;
