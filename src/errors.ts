export class RouterSdkError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RouterSdkError";
    this.code = code;
  }
}

export class NotImplementedError extends RouterSdkError {
  constructor(operation: string) {
    super("NOT_IMPLEMENTED", operation + " is not implemented.");
    this.name = "NotImplementedError";
  }
}
