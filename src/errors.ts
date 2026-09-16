export class RouterSdkError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RouterSdkError";
    this.code = code;
  }
}
