// Work in this window that ending the process would cut short (an export
// between its save dialog and its written file). An installer that ran
// through it would lose the file the user asked for, and the drain cannot
// see it, so both install paths wait it out.
let holds = 0;

export function updateHeldOff(): boolean {
  return holds > 0;
}

export async function holdOffUpdate<T>(work: () => Promise<T>): Promise<T> {
  holds++;
  try {
    return await work();
  } finally {
    holds--;
  }
}
