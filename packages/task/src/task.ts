import { bind } from '@wry/context';

const enum State {
  UNSETTLED,
  SETTLING,
  RESOLVED,
  REJECTED,
}

function isPromiseLike(value: any): value is PromiseLike<any> {
  return value && typeof value.then === 'function';
}

// A Task is a deliberately stripped-down Promise-compatible abstraction
// with a few notable differences:
//
// 1. Settled Tasks can fire .then callbacks synchronously. If you've ever
//    tried to extract code containing conditional await expressions from
//    an async function, you will realize that the precise internal timing
//    of asynchronous code sometimes requires synchronous delivery of
//    results. Don't get me wrong: I'm a huge fan of the always-async
//    consistency of the Promise API, but it simply isn't flexible enough
//    to support certain patterns, especially when working with Observables,
//    which also have the ability to deliver results synchronously.
//
// 2. Tasks expose their .resolve and .reject methods publicly, so you can
//    call them easily outside the Task constructor. I am well aware that
//    the designers of the Promise API valued separating the concerns of
//    the producer from those of consumers, but the extra convenience is
//    just too nice to give up.
//
// 3. A Task can be turned into an equivalent Promise via task.toPromise().

export class Task<TResult> implements PromiseLike<TResult> {
  // The task.resolve and task.reject methods are similar to the Promise
  // resolve and reject functions, except they are exposed publicly. These
  // methods come pre-bound, and they are idempotent, meaning the first call
  // always wins, even if the argument is a Task/Promise/thenable that needs
  // to be resolved.
  public readonly resolve =
    (result: TResult | PromiseLike<TResult>) => this.settle(State.RESOLVED, result);
  public readonly reject = (reason: any) => this.settle(State.REJECTED, reason);

  private state: State = State.UNSETTLED;
  private resultOrError?: any;

  // More Task.WHATEVER constants can be added here as necessary.
  static readonly VOID = new Task<void>(task => task.resolve());

  constructor(exec?: (task: Task<TResult>) => void) {
    // Since Tasks expose their task.resolve and task.reject functions publicly,
    // it's not always necessary to pass a function to the Task constructor,
    // though it's probably a good idea if you want to catch exceptions thrown
    // by the setup code.
    if (exec) {
      try {
        exec(this);
      } catch (error) {
        this.reject(error);
      }
    }
  }

  static resolve<T>(value: T | PromiseLike<T>): Task<T> {
    return new this<T>(task => task.resolve(value));
  }

  static reject<T>(value: T | PromiseLike<T>): Task<T> {
    return new this<T>(task => task.reject(value));
  }

  public then<A = TResult, B = never>(
    onResolved?: ((value: TResult) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: any) => B | PromiseLike<B>) | null,
  ): Task<A | B> {
    switch (this.state) {
      case State.UNSETTLED:
      case State.SETTLING:
        return Task.resolve(this.toPromise().then(
          onResolved && bind(onResolved),
          onRejected && bind(onRejected),
        ));

      case State.RESOLVED:
        return new Task<any>(task => task.resolve(
          onResolved ? onResolved(this.resultOrError) : this.resultOrError,
        ));

      case State.REJECTED:
        return new Task<any>(task => task.resolve(
          onRejected ? onRejected(this.resultOrError) : this.resultOrError,
        ));
    }
  }

  public catch<T>(onRejected: (reason: any) => T | PromiseLike<T>) {
    return this.then(null, onRejected);
  }

  // Although Task is intended to be lighter-weight than Promise, a Task can be
  // easily turned into a Promise by calling task.toPromise(), at which point
  // the equivalent Promise<TResult> will be created.
  private promise?: Promise<TResult>;

  public toPromise(): Promise<TResult> {
    if (this.promise) {
      return this.promise;
    }

    switch (this.state) {
      case State.UNSETTLED:
      case State.SETTLING:
        return this.promise = new Promise<TResult>((resolve, reject) => {
          const { finalize } = this;
          this.finalize = (state, resultOrError) => {
            finalize.call(this, state, resultOrError);
            if (state === State.RESOLVED) {
              resolve(resultOrError);
            } else {
              reject(resultOrError);
            }
          };
        });
      case State.RESOLVED:
        return this.promise = Promise.resolve(this.resultOrError);
      case State.REJECTED:
        return this.promise = Promise.reject(this.resultOrError);
    }
  }

  private settle(
    tentativeState: State.RESOLVED | State.REJECTED,
    resultOrError: any,
  ) {
    if (this.state === State.UNSETTLED) {
      if (tentativeState === State.RESOLVED && isPromiseLike(resultOrError)) {
        this.state = State.SETTLING;
        resultOrError.then(
          result => this.finalize(State.RESOLVED, result),
          error => this.finalize(State.REJECTED, error),
        );
      } else {
        this.finalize(tentativeState, resultOrError);
      }
    }
  }

  // This method may get wrapped in toPromise so that finalization also calls
  // the resolve or reject functions for this.promise.
  private finalize(
    state: State.RESOLVED | State.REJECTED,
    resultOrError: any,
  ) {
    this.state = state;
    this.resultOrError = resultOrError;
  }
}
