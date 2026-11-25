// Transport errors must not import the database-backed action journal.
export class UncertainAction extends Error {
  constructor(message,evidence) { super(message); this.name='UncertainAction'; if(evidence!==undefined)this.evidence=evidence; }
}
