/* =============================================================================
   Where the portal finds its backend.
   -----------------------------------------------------------------------------
   Set `apiBase` to the ApiUrl the CloudFormation stack outputs, e.g.
       https://abc123.execute-api.ap-south-1.amazonaws.com/v1

   Left as "/api" it talks to whatever serves the page, which is what the local
   dev server (backend/local/server.js) provides.
   ========================================================================== */
(function (global) {
    'use strict';
    var SPX = global.SPX = global.SPX || {};
    SPX.config = { apiBase: '/api' };
})(window);
