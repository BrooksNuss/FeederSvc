export interface FeederSqsMessage {
	type: FeederApiType;
	id: string;
}

export type FeederApiType = 'activate' | 'list-info' | 'skip' | 'toggle-enabled';
export type FeederApiResources = '/activate/{id}' | '/list-info' | '/skip/{id}' | '/toggle-enabled/{id}'