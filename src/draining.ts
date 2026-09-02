// Is this process on its way out?
//
// One boolean, module scope, because there is exactly one process and every surface has to
// agree about it. Threading it through the request context would mean the same answer stored in
// two places, and the failure mode of that is a route that accepts a write two hundred
// milliseconds before the sockets close.
//
// Reads keep working while draining. Only writes are refused, and they are refused with 503 and
// a sentence, because "the app is stopping" is a temporary and honest answer that a client can
// act on, where a hang or a closed socket is neither.

let draining = false;

export function beginDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

// For tests only. Nothing in the app ever un-drains: a process that has begun stopping does not
// change its mind.
export function resetDrainingForTests(): void {
  draining = false;
}
