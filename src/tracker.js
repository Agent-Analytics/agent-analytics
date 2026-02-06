/**
 * Embedded tracker.js - client-side analytics snippet
 * Served as plain JavaScript from GET /tracker.js
 *
 * Project token is passed in the request body (like Mixpanel).
 * No custom headers = no CORS preflight = zero issues.
 */
export const TRACKER_JS = `
(function() {
  'use strict';
  
  var script = document.currentScript;
  var ENDPOINT = script && script.src
    ? new URL(script.src).origin + '/track'
    : '/track';
  
  var PROJECT = (script && script.dataset.project) || 'default';
  var TOKEN = (script && script.dataset.token) || null;
  
  // Simple fingerprint for anonymous users
  function getAnonId() {
    var id = localStorage.getItem('aa_uid');
    if (!id) {
      id = 'anon_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('aa_uid', id);
    }
    return id;
  }
  
  var userId = getAnonId();
  
  var aa = {
    token: TOKEN,
    
    track: function(event, properties) {
      var payload = {
        project: PROJECT,
        token: aa.token,
        event: event,
        properties: Object.assign({
          url: location.href,
          referrer: document.referrer,
          screen: screen.width + 'x' + screen.height,
        }, properties || {}),
        user_id: userId,
        timestamp: Date.now()
      };
      
      // Plain fetch with no credentials — simple CORS, no preflight
      var data = JSON.stringify(payload);
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data,
        keepalive: true,
        credentials: 'omit'
      }).catch(function() {});
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
