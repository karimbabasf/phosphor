/* The trace: driver frames become steps in the transcript and beams on the
   world. Interface stub; the beam track builds it.

     start()     subscribe to driver, transactions and state frames
     surfaceOf(toolName) -> { id, tone } */
(function () {
  'use strict';

  function surfaceOf() {
    return { id: 'assistant', tone: 'glow' };
  }

  window.PhosphorTrace = {
    start: function () {},
    surfaceOf: surfaceOf
  };
})();
