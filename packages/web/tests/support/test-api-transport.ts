import { ApiConnectionError, WorkerApiTransport } from "../../src/services/api/worker-api-transport.ts";

export class TestApiTransport {
    readonly #origin: string;
    #current: WorkerApiTransport;
    constructor(origin: string) {
        this.#origin = origin;
        this.#current = new WorkerApiTransport(origin);
    }
    readonly open = () => {
        this.#current.dispose();
        this.#current = new WorkerApiTransport(this.#origin);
    };
    readonly disconnect = () => this.#current.dispose(new ApiConnectionError("Network disconnected."));
    readonly dispose = this.disconnect;
    readonly computerTransport: WorkerApiTransport["computerTransport"] = (computerId) =>
        this.#current.computerTransport(computerId);
    readonly fetch: WorkerApiTransport["fetch"] = (request) => this.#current.fetch(request);
    readonly measureMortyLatency: WorkerApiTransport["measureMortyLatency"] = (signal) =>
        this.#current.measureMortyLatency(signal);
    readonly request = async (request: Request): Promise<Response> => await fetch(request);
    readonly waitForChange: WorkerApiTransport["waitForChange"] = (request, ready) =>
        this.#current.waitForChange(request, ready);
}
