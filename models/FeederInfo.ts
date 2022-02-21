export interface FeederInfo {
    id: string;
    name: string;
    status: 'ONLINE' | 'OFFLINE';
    lastActive: string;
    nextActive: string;
    interval: string;
    estRemainingFood: number;
    estRemainingFeedings: number;
}