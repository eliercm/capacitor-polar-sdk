import { WebPlugin } from '@capacitor/core';
import { PolarDataType } from './definitions';
import { PftpClient } from './pftp-client';
import { initProtobuf, encodeFtuConfig, encodeUserIdentifier, encodeSetLocalTimeParams, createPftpOperation } from './polar-protobuf';
const POLAR_MANUFACTURER_ID = 0x006b;
const HEART_RATE_SERVICE = 0x180d;
const BATTERY_SERVICE = 0x180f;
const HEART_RATE_CHARACTERISTIC = 0x2a37;
const BATTERY_CHARACTERISTIC = 0x2a19;
const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CP = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';
const PSFTP_SERVICE = '0000feee-0000-1000-8000-00805f9b34fb';
const PSFTP_MTU_CHARACTERISTIC = 'fb005c51-02e7-f387-1cad-8acd2d8df0c8';
const PSFTP_D2H_NOTIFICATION = 'fb005c52-02e7-f387-1cad-8acd2d8df0c8';
const PSFTP_H2D_NOTIFICATION = 'fb005c53-02e7-f387-1cad-8acd2d8df0c8';
const PMD_COMMAND = {
    GET_MEASUREMENT_SETTINGS: 0x01,
    REQUEST_MEASUREMENT_START: 0x02,
    STOP_MEASUREMENT: 0x03,
    GET_SDK_MODE_SETTINGS: 0x04,
    GET_MEASUREMENT_STATUS: 0x05,
};
const PMD_MEASUREMENT_TYPE = {
    ECG: 0x00,
    PPG: 0x01,
    ACC: 0x02,
    PPI: 0x03,
    GYRO: 0x05,
    MAGNETOMETER: 0x06,
    TEMPERATURE: 0x07,
    PRESSURE: 0x08,
};
export class PolarSdkWeb extends WebPlugin {
    constructor() {
        super(...arguments);
        this.devices = new Map();
        this.initialized = false;
        this.ftuStatusMap = new Map();
    }
    async initialize() {
        if (!navigator.bluetooth) {
            throw new Error('Web Bluetooth API is not available in this browser');
        }
        // Initialize Protocol Buffers
        try {
            initProtobuf();
            console.log('Protocol Buffers initialized for FTU support');
        }
        catch (error) {
            console.warn('Failed to initialize Protocol Buffers:', error);
        }
        this.initialized = true;
    }
    async connectToDevice(options) {
        if (!this.initialized) {
            await this.initialize();
        }
        if (this.devices.has(options.identifier)) {
            return;
        }
        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'Polar 360' }
                ],
                optionalServices: [HEART_RATE_SERVICE, BATTERY_SERVICE, PMD_SERVICE, PSFTP_SERVICE],
            });
            if (!device.gatt) {
                throw new Error('GATT server not available');
            }
            const deviceInfo = {
                deviceId: options.identifier,
                address: device.id,
                rssi: 0,
                name: device.name || 'Unknown',
                isConnectable: true,
            };
            this.notifyListeners('deviceConnecting', deviceInfo);
            const gattServer = await device.gatt.connect();
            const connectedDevice = {
                device,
                gattServer,
                isStreaming: false,
                streamingFeatures: new Set(),
                offlineRecordings: new Map(),
            };
            this.devices.set(options.identifier, connectedDevice);
            device.addEventListener('gattserverdisconnected', () => {
                this.handleDeviceDisconnected(options.identifier);
            });
            this.notifyListeners('deviceConnected', deviceInfo);
            await this.setupBatteryService(options.identifier);
        }
        catch (error) {
            throw new Error(`Failed to connect: ${error}`);
        }
    }
    async disconnectFromDevice(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            return;
        }
        if (connectedDevice.isStreaming) {
            await this.stopStreaming({ identifier: options.identifier, feature: PolarDataType.HR });
        }
        if (connectedDevice.gattServer.connected) {
            connectedDevice.gattServer.disconnect();
        }
        this.devices.delete(options.identifier);
    }
    async searchForDevice() {
        var _a, _b, _c, _d, _e;
        if (!this.initialized) {
            await this.initialize();
        }
        try {
            let device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'Polar 360' }
                ],
                optionalServices: [HEART_RATE_SERVICE, BATTERY_SERVICE, PMD_SERVICE, PSFTP_SERVICE],
            });
            const deviceId = this.extractDeviceId(device.name || '');
            const deviceInfo = {
                deviceId: deviceId,
                address: device.id,
                rssi: 0,
                name: device.name || 'Unknown',
                isConnectable: true,
            };
            this.notifyListeners('deviceFound', deviceInfo);
            // Automatically connect within the same user gesture
            if (!this.devices.has(deviceId)) {
                let gattServer;
                try {
                    console.log('Attempting GATT connection...');
                    gattServer = await ((_a = device.gatt) === null || _a === void 0 ? void 0 : _a.connect());
                }
                catch (connectError) {
                    console.warn('❌ First connection attempt failed:', connectError.message);
                    // If connection fails, try to forget stale pairing and reconnect
                    if (((_b = connectError.message) === null || _b === void 0 ? void 0 : _b.includes('Connection')) || ((_c = connectError.message) === null || _c === void 0 ? void 0 : _c.includes('GATT'))) {
                        console.log('🔄 Attempting to forget device and re-pair...');
                        try {
                            // Try to forget the device
                            if (typeof device.forget === 'function') {
                                console.log('Forgetting device...');
                                await device.forget();
                                console.log('✅ Device forgotten');
                                // Wait a moment
                                await new Promise(resolve => setTimeout(resolve, 500));
                                // Request device again for fresh pairing
                                console.log('Requesting fresh pairing...');
                                const freshDevice = await navigator.bluetooth.requestDevice({
                                    filters: [
                                        {
                                            namePrefix: 'Polar 360',
                                            manufacturerData: [{ companyIdentifier: POLAR_MANUFACTURER_ID }],
                                        },
                                    ],
                                    acceptAllDevices: false,
                                    optionalServices: [HEART_RATE_SERVICE, BATTERY_SERVICE, PMD_SERVICE, PSFTP_SERVICE],
                                });
                                console.log('Connecting to freshly paired device...');
                                gattServer = await ((_d = freshDevice.gatt) === null || _d === void 0 ? void 0 : _d.connect());
                                console.log('✅ Connected successfully after re-pairing!');
                                // Update device reference for the rest of the code
                                device = freshDevice;
                            }
                            else {
                                // device.forget() not available, try simple retry
                                console.log('device.forget() not available, trying simple retry...');
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                gattServer = await ((_e = device.gatt) === null || _e === void 0 ? void 0 : _e.connect());
                            }
                        }
                        catch (retryError) {
                            console.error('❌ Re-pairing failed:', retryError.message);
                            throw new Error('❌ Connection failed. Manual re-pairing required:\n\n' +
                                '1. Open chrome://bluetooth-internals/#devices\n' +
                                '2. Find "Polar 360" and click "Forget" or "Remove"\n' +
                                '3. Close and reopen this browser tab\n' +
                                '4. Make sure device LED is blinking (pairing mode)\n' +
                                '5. Try connecting again\n\n' +
                                `Original error: ${connectError.message}`);
                        }
                    }
                    else {
                        throw connectError;
                    }
                }
                if (!gattServer) {
                    throw new Error('Failed to establish GATT connection');
                }
                const connectedDevice = {
                    device,
                    gattServer,
                    isStreaming: false,
                    streamingFeatures: new Set(),
                    offlineRecordings: new Map(),
                };
                this.devices.set(deviceId, connectedDevice);
                device.addEventListener('gattserverdisconnected', () => {
                    this.handleDeviceDisconnected(deviceId);
                });
                this.notifyListeners('deviceConnected', deviceInfo);
                await this.setupBatteryService(deviceId);
            }
            return { value: true };
        }
        catch (error) {
            console.error('Device search error:', error);
            console.error('Error details:', {
                message: error.message,
                name: error.name,
                code: error.code
            });
            throw error;
        }
    }
    async getAvailableOnlineStreamDataTypes(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        const types = [PolarDataType.HR, PolarDataType.PPI];
        return { types };
    }
    async requestStreamSettings(_options) {
        return { settings: {} };
    }
    async startHrStreaming(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            if (!connectedDevice.heartRateService) {
                connectedDevice.heartRateService = await connectedDevice.gattServer.getPrimaryService(HEART_RATE_SERVICE);
            }
            if (!connectedDevice.heartRateCharacteristic) {
                connectedDevice.heartRateCharacteristic = await connectedDevice.heartRateService.getCharacteristic(HEART_RATE_CHARACTERISTIC);
            }
            connectedDevice.heartRateCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                const target = event.target;
                const value = target.value;
                if (value) {
                    const hrData = this.parseHeartRate(value);
                    this.notifyListeners('hrData', {
                        identifier: options.identifier,
                        data: { hr: hrData, rrs: [], contactStatus: true, contactStatusSupported: false },
                    });
                }
            });
            await connectedDevice.heartRateCharacteristic.startNotifications();
            connectedDevice.isStreaming = true;
            this.notifyListeners('sdkFeatureReady', { identifier: options.identifier, feature: PolarDataType.HR });
            return { value: true };
        }
        catch (error) {
            throw new Error(`Failed to start HR streaming: ${error}`);
        }
    }
    async startEcgStreaming(_options) {
        throw this.unimplemented('ECG streaming not supported on web.');
    }
    async startAccStreaming(_options) {
        throw this.unimplemented('Accelerometer streaming not supported on web.');
    }
    async startGyroStreaming(_options) {
        throw this.unimplemented('Gyroscope streaming not supported on web.');
    }
    async startMagnetometerStreaming(_options) {
        throw this.unimplemented('Magnetometer streaming not supported on web.');
    }
    async startPpgStreaming(_options) {
        throw this.unimplemented('PPG streaming not supported on web.');
    }
    async startPpiStreaming(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            if (!connectedDevice.pmdService) {
                connectedDevice.pmdService = await connectedDevice.gattServer.getPrimaryService(PMD_SERVICE);
            }
            if (!connectedDevice.pmdCpCharacteristic) {
                connectedDevice.pmdCpCharacteristic = await connectedDevice.pmdService.getCharacteristic(PMD_CP);
            }
            if (!connectedDevice.pmdDataCharacteristic) {
                connectedDevice.pmdDataCharacteristic = await connectedDevice.pmdService.getCharacteristic(PMD_DATA);
            }
            connectedDevice.pmdDataCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                const target = event.target;
                const value = target.value;
                if (value) {
                    const ppiData = this.parsePmdData(value, PMD_MEASUREMENT_TYPE.PPI);
                    if (ppiData) {
                        this.notifyListeners('ppiData', {
                            identifier: options.identifier,
                            data: ppiData,
                        });
                    }
                }
            });
            await connectedDevice.pmdDataCharacteristic.startNotifications();
            const startCommand = new Uint8Array([
                PMD_COMMAND.REQUEST_MEASUREMENT_START,
                PMD_MEASUREMENT_TYPE.PPI,
            ]);
            await connectedDevice.pmdCpCharacteristic.writeValue(startCommand);
            connectedDevice.streamingFeatures.add(PolarDataType.PPI);
            this.notifyListeners('sdkFeatureReady', { identifier: options.identifier, feature: PolarDataType.PPI });
            return { value: true };
        }
        catch (error) {
            throw new Error(`Failed to start PPI streaming: ${error}`);
        }
    }
    async startTemperatureStreaming(_options) {
        throw this.unimplemented('Temperature streaming not supported on web.');
    }
    async startPressureStreaming(_options) {
        throw this.unimplemented('Pressure streaming not supported on web.');
    }
    async stopStreaming(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            if (options.feature === PolarDataType.HR && connectedDevice.heartRateCharacteristic) {
                await connectedDevice.heartRateCharacteristic.stopNotifications();
                connectedDevice.isStreaming = false;
            }
            else if (options.feature === PolarDataType.PPI && connectedDevice.pmdCpCharacteristic) {
                const stopCommand = new Uint8Array([
                    PMD_COMMAND.STOP_MEASUREMENT,
                    PMD_MEASUREMENT_TYPE.PPI,
                ]);
                await connectedDevice.pmdCpCharacteristic.writeValue(stopCommand);
                connectedDevice.streamingFeatures.delete(PolarDataType.PPI);
            }
            return { value: true };
        }
        catch (error) {
            throw new Error(`Failed to stop streaming: ${error}`);
        }
    }
    async setupBatteryService(identifier) {
        const connectedDevice = this.devices.get(identifier);
        if (!connectedDevice)
            return;
        try {
            connectedDevice.batteryService = await connectedDevice.gattServer.getPrimaryService(BATTERY_SERVICE);
            connectedDevice.batteryCharacteristic = await connectedDevice.batteryService.getCharacteristic(BATTERY_CHARACTERISTIC);
            connectedDevice.batteryCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                const target = event.target;
                const value = target.value;
                if (value) {
                    const batteryLevel = this.parseBatteryLevel(value);
                    this.notifyListeners('batteryLevelReceived', { identifier, level: batteryLevel });
                }
            });
            await connectedDevice.batteryCharacteristic.startNotifications();
            const batteryData = await connectedDevice.batteryCharacteristic.readValue();
            const batteryLevel = this.parseBatteryLevel(batteryData);
            this.notifyListeners('batteryLevelReceived', { identifier, level: batteryLevel });
        }
        catch (error) {
            console.error('Battery service setup failed:', error);
        }
    }
    parseHeartRate(data) {
        const flags = data.getUint8(0);
        const hrFormat = flags & 0x01;
        if (hrFormat === 0) {
            return data.getUint8(1);
        }
        else {
            return data.getUint16(1, true);
        }
    }
    parseBatteryLevel(data) {
        return data.getUint8(0);
    }
    extractDeviceId(name) {
        const match = name.match(/Polar 360 (.+)/);
        return match ? match[1] : name;
    }
    getDataTypeName(dataType) {
        switch (dataType) {
            case PolarDataType.HR: return 'HR';
            case PolarDataType.ECG: return 'ECG';
            case PolarDataType.ACC: return 'ACC';
            case PolarDataType.PPG: return 'PPG';
            case PolarDataType.PPI: return 'PPI';
            case PolarDataType.GYRO: return 'GYRO';
            case PolarDataType.MAGNETOMETER: return 'MAG';
            case PolarDataType.TEMPERATURE: return 'TEMP';
            case PolarDataType.PRESSURE: return 'PRESS';
            default: return 'UNKNOWN';
        }
    }
    handleDeviceDisconnected(identifier) {
        const connectedDevice = this.devices.get(identifier);
        if (connectedDevice) {
            const deviceInfo = {
                deviceId: identifier,
                address: connectedDevice.device.id,
                rssi: 0,
                name: connectedDevice.device.name || 'Unknown',
                isConnectable: false,
            };
            this.notifyListeners('deviceDisconnected', deviceInfo);
            this.devices.delete(identifier);
        }
    }
    parsePmdData(data, measurementType) {
        if (measurementType === PMD_MEASUREMENT_TYPE.PPI) {
            return this.parsePpiData(data);
        }
        return null;
    }
    parsePpiData(data) {
        const samples = [];
        try {
            let offset = 0;
            if (data.byteLength < 1)
                return { samples };
            const frameType = data.getUint8(offset);
            offset++;
            if (frameType === 0x00) {
                const timestamp = data.getUint32(offset, true);
                offset += 8;
                while (offset < data.byteLength) {
                    if (offset + 5 > data.byteLength)
                        break;
                    const ppInterval = data.getUint16(offset, true);
                    offset += 2;
                    const errorEstimate = data.getUint16(offset, true);
                    offset += 2;
                    const flags = data.getUint8(offset);
                    offset++;
                    const blocker = (flags & 0x01) !== 0;
                    const skinContactSupported = (flags & 0x02) !== 0;
                    const skinContact = (flags & 0x04) !== 0;
                    samples.push({
                        ppInterval,
                        errorEstimate,
                        blocker,
                        skinContactSupported,
                        skinContact,
                    });
                }
                return { samples, timestamp };
            }
        }
        catch (error) {
            console.error('Error parsing PPI data:', error);
        }
        return { samples };
    }
    async startRecording(options) {
        console.log('startRecording', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async stopRecording(options) {
        console.log('stopRecording', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async requestRecordingStatus(options) {
        console.log('requestRecordingStatus', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async listExercises(options) {
        console.log('listExercises', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async fetchExercise(options) {
        console.log('fetchExercise', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async removeExercise(options) {
        console.log('removeExercise', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async setLedConfig(options) {
        console.log('setLedConfig', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async doFactoryReset(options) {
        console.log('doFactoryReset', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async enableSdkMode(options) {
        console.log('enableSdkMode', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async disableSdkMode(options) {
        console.log('disableSdkMode', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async isSdkModeEnabled(options) {
        console.log('isSdkModeEnabled', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async getAvailableOfflineRecordingDataTypes(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        const types = [PolarDataType.PPI, PolarDataType.ACC, PolarDataType.PPG];
        return { types };
    }
    async requestOfflineRecordingSettings(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        return { settings: {} };
    }
    async startOfflineRecording(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            if (!connectedDevice.pmdService) {
                connectedDevice.pmdService = await connectedDevice.gattServer.getPrimaryService(PMD_SERVICE);
            }
            if (!connectedDevice.pmdCpCharacteristic) {
                connectedDevice.pmdCpCharacteristic = await connectedDevice.pmdService.getCharacteristic(PMD_CP);
            }
            let measurementType = PMD_MEASUREMENT_TYPE.PPI;
            if (options.feature === PolarDataType.ACC) {
                measurementType = PMD_MEASUREMENT_TYPE.ACC;
            }
            else if (options.feature === PolarDataType.PPG) {
                measurementType = PMD_MEASUREMENT_TYPE.PPG;
            }
            const startCommand = new Uint8Array([
                PMD_COMMAND.REQUEST_MEASUREMENT_START,
                measurementType,
            ]);
            await connectedDevice.pmdCpCharacteristic.writeValue(startCommand);
            connectedDevice.streamingFeatures.add(options.feature);
        }
        catch (error) {
            throw new Error(`Failed to start offline recording: ${error}`);
        }
    }
    async stopOfflineRecording(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            if (!connectedDevice.pmdCpCharacteristic) {
                throw new Error('PMD service not initialized');
            }
            let measurementType = PMD_MEASUREMENT_TYPE.PPI;
            if (options.feature === PolarDataType.ACC) {
                measurementType = PMD_MEASUREMENT_TYPE.ACC;
            }
            else if (options.feature === PolarDataType.PPG) {
                measurementType = PMD_MEASUREMENT_TYPE.PPG;
            }
            const stopCommand = new Uint8Array([
                PMD_COMMAND.STOP_MEASUREMENT,
                measurementType,
            ]);
            await connectedDevice.pmdCpCharacteristic.writeValue(stopCommand);
            connectedDevice.streamingFeatures.delete(options.feature);
        }
        catch (error) {
            throw new Error(`Failed to stop offline recording: ${error}`);
        }
    }
    async getOfflineRecordingStatus(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        return { features: Array.from(connectedDevice.streamingFeatures) };
    }
    async listOfflineRecordings(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            if (!connectedDevice.psFtpService) {
                connectedDevice.psFtpService = await connectedDevice.gattServer.getPrimaryService(PSFTP_SERVICE);
            }
            const recordings = connectedDevice.streamingFeatures;
            const entries = [];
            recordings.forEach((feature) => {
                const type = this.getDataTypeName(feature);
                entries.push({
                    path: `/DATA/${type}/RECORDING_${Date.now()}.dat`,
                    size: 0,
                    date: new Date().toISOString(),
                    type: type,
                });
            });
            return { entries };
        }
        catch (error) {
            console.warn('PFTP service not available. Returning cached recordings.');
            return { entries: [] };
        }
    }
    async getOfflineRecord(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            if (!connectedDevice.psFtpService) {
                connectedDevice.psFtpService = await connectedDevice.gattServer.getPrimaryService(PSFTP_SERVICE);
            }
            if (!connectedDevice.psFtpMtuCharacteristic) {
                connectedDevice.psFtpMtuCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_MTU_CHARACTERISTIC);
            }
            if (!connectedDevice.psFtpD2HCharacteristic) {
                connectedDevice.psFtpD2HCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_D2H_NOTIFICATION);
            }
            if (!connectedDevice.psFtpH2DCharacteristic) {
                connectedDevice.psFtpH2DCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_H2D_NOTIFICATION);
            }
            await connectedDevice.psFtpD2HCharacteristic.startNotifications();
            const recordingData = connectedDevice.offlineRecordings.get(options.entry.path);
            if (recordingData) {
                return {
                    startTime: recordingData.startTime || new Date().toISOString(),
                    settings: recordingData.settings,
                };
            }
            console.warn('Full PFTP implementation required for actual file retrieval');
            return {
                startTime: new Date().toISOString(),
                settings: undefined,
            };
        }
        catch (error) {
            throw new Error(`Failed to retrieve offline record: ${error}`);
        }
    }
    async removeOfflineRecord(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error('Device not connected');
        }
        try {
            connectedDevice.offlineRecordings.delete(options.entry.path);
            console.warn('Full PFTP implementation required for actual file deletion from device');
        }
        catch (error) {
            throw new Error(`Failed to remove offline record: ${error}`);
        }
    }
    async getDiskSpace(options) {
        console.log('getDiskSpace', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async getLocalTime(options) {
        console.log('getLocalTime', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async setLocalTime(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error(`Device ${options.identifier} is not connected`);
        }
        try {
            if (!connectedDevice.psFtpService) {
                const gattServer = connectedDevice.gattServer;
                connectedDevice.psFtpService = await gattServer.getPrimaryService(PSFTP_SERVICE);
            }
            if (!connectedDevice.psFtpMtuCharacteristic) {
                connectedDevice.psFtpMtuCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_MTU_CHARACTERISTIC);
            }
            if (!connectedDevice.psFtpD2HCharacteristic) {
                connectedDevice.psFtpD2HCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_D2H_NOTIFICATION);
            }
            console.log(`Setting local time to ${options.time.toISOString()}`);
            const pftpClient = new PftpClient(connectedDevice.psFtpMtuCharacteristic, connectedDevice.psFtpD2HCharacteristic, connectedDevice.psFtpH2DCharacteristic);
            await pftpClient.initialize();
            const SET_LOCAL_TIME_QUERY = 3;
            const timeParams = encodeSetLocalTimeParams(options.time);
            await pftpClient.sendQuery(SET_LOCAL_TIME_QUERY, timeParams);
            console.log('✅ Local time set successfully');
        }
        catch (error) {
            console.error('Failed to set local time:', error);
            throw new Error(`Failed to set local time: ${error}`);
        }
    }
    async doFirstTimeUse(options) {
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            throw new Error(`Device ${options.identifier} is not connected`);
        }
        const config = options.config;
        if (config.height < 90 || config.height > 240) {
            throw new Error('Height must be between 90 and 240 cm');
        }
        if (config.weight < 15 || config.weight > 300) {
            throw new Error('Weight must be between 15 and 300 kg');
        }
        if (config.maxHeartRate < 100 || config.maxHeartRate > 240) {
            throw new Error('Max heart rate must be between 100 and 240 bpm');
        }
        if (config.restingHeartRate < 20 || config.restingHeartRate > 120) {
            throw new Error('Resting heart rate must be between 20 and 120 bpm');
        }
        if (config.vo2Max < 10 || config.vo2Max > 95) {
            throw new Error('VO2 max must be between 10 and 95');
        }
        if (config.sleepGoalMinutes < 300 || config.sleepGoalMinutes > 660) {
            throw new Error('Sleep goal must be between 300 and 660 minutes (5-11 hours)');
        }
        try {
            if (!connectedDevice.psFtpService) {
                const gattServer = connectedDevice.gattServer;
                connectedDevice.psFtpService = await gattServer.getPrimaryService(PSFTP_SERVICE);
            }
            if (!connectedDevice.psFtpH2DCharacteristic) {
                connectedDevice.psFtpH2DCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_H2D_NOTIFICATION);
            }
            if (!connectedDevice.psFtpD2HCharacteristic) {
                connectedDevice.psFtpD2HCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_D2H_NOTIFICATION);
            }
            if (!connectedDevice.psFtpMtuCharacteristic) {
                connectedDevice.psFtpMtuCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_MTU_CHARACTERISTIC);
            }
            console.log('=== WRITING FTU CONFIGURATION TO DEVICE ===');
            console.log('FTU Config:', {
                gender: config.gender,
                birthDate: config.birthDate,
                height: config.height,
                weight: config.weight,
                maxHR: config.maxHeartRate,
                vo2Max: config.vo2Max,
                restingHR: config.restingHeartRate,
                trainingBg: config.trainingBackground,
                typicalDay: config.typicalDay,
                sleepGoal: config.sleepGoalMinutes
            });
            // Encode FTU config to Protocol Buffers
            console.log('Encoding FTU config to protobuf...');
            const ftuData = encodeFtuConfig({
                gender: config.gender,
                birthDate: config.birthDate,
                height: config.height,
                weight: config.weight,
                maxHeartRate: config.maxHeartRate,
                vo2Max: config.vo2Max,
                restingHeartRate: config.restingHeartRate,
                trainingBackground: config.trainingBackground,
                deviceTime: config.deviceTime,
                typicalDay: config.typicalDay,
                sleepGoalMinutes: config.sleepGoalMinutes
            });
            console.log(`Protobuf encoded: ${ftuData.length} bytes`);
            // Create PFTP client
            console.log('Initializing PFTP client...');
            const pftpClient = new PftpClient(connectedDevice.psFtpMtuCharacteristic, connectedDevice.psFtpD2HCharacteristic, connectedDevice.psFtpH2DCharacteristic);
            await pftpClient.initialize();
            // Step 1: Write physical data config
            const FTU_PATH = '/U/0/S/PHYSDATA.BPB';
            console.log(`Step 1: Writing ${ftuData.length} bytes to ${FTU_PATH}...`);
            const pftpOperation = createPftpOperation('PUT', FTU_PATH);
            await pftpClient.writeFile(FTU_PATH, ftuData, pftpOperation);
            console.log('✅ Physical data config written');
            // Step 2: Write user identifier
            const USER_ID_PATH = '/U/0/USERID.BPB';
            console.log(`Step 2: Writing user identifier to ${USER_ID_PATH}...`);
            const userIdData = encodeUserIdentifier(config.deviceTime);
            const userIdOperation = createPftpOperation('PUT', USER_ID_PATH);
            await pftpClient.writeFile(USER_ID_PATH, userIdData, userIdOperation);
            console.log('✅ User identifier written');
            // Step 3: Set local time
            console.log(`Step 3: Setting local time...`);
            const SET_LOCAL_TIME_QUERY = 3;
            const timeParams = encodeSetLocalTimeParams(new Date(config.deviceTime));
            await pftpClient.sendQuery(SET_LOCAL_TIME_QUERY, timeParams);
            console.log('✅ Local time set');
            console.log('✅✅✅ FTU COMPLETED! Device should stop blinking now ✅✅✅');
            this.ftuStatusMap.set(options.identifier, true);
            connectedDevice.ftuCompleted = true;
            this.notifyListeners('ftuCompleted', {
                identifier: options.identifier,
                success: true
            });
            console.log('================================================');
        }
        catch (error) {
            console.error('Failed to write FTU configuration:', error);
            throw new Error(`Failed to perform First Time Use: ${error}`);
        }
    }
    async getConnectionStatus(options) {
        var _a, _b, _c;
        console.log('🔍 Checking connection status for:', options.identifier);
        // Check if we have the device in our map
        const connectedDevice = this.devices.get(options.identifier);
        // Check browser's paired devices
        let browserPaired = false;
        let pairedDevices = [];
        try {
            if (typeof ((_a = navigator.bluetooth) === null || _a === void 0 ? void 0 : _a.getDevices) === 'function') {
                pairedDevices = await navigator.bluetooth.getDevices();
                browserPaired = pairedDevices.some((d) => { var _a; return ((_a = d.name) === null || _a === void 0 ? void 0 : _a.includes('Polar')) || d.id === options.identifier; });
                console.log('Browser paired devices:', pairedDevices.map((d) => ({ name: d.name, id: d.id })));
            }
        }
        catch (e) {
            console.warn('Could not check browser paired devices:', e);
        }
        if (!connectedDevice) {
            const details = browserPaired
                ? `⚠️ Device is paired in browser but not connected in app. Found ${pairedDevices.length} paired device(s).`
                : '❌ Device not found in app and not paired in browser.';
            console.log(details);
            return {
                connected: false,
                gattConnected: false,
                deviceName: 'Not in app',
                services: [],
                browserPaired,
                details
            };
        }
        const gattConnected = ((_b = connectedDevice.gattServer) === null || _b === void 0 ? void 0 : _b.connected) || false;
        const deviceName = ((_c = connectedDevice.device) === null || _c === void 0 ? void 0 : _c.name) || 'Unknown';
        // Try to list available services
        const services = [];
        if (gattConnected) {
            try {
                if (connectedDevice.heartRateService)
                    services.push('Heart Rate');
                if (connectedDevice.batteryService)
                    services.push('Battery');
                if (connectedDevice.pmdService)
                    services.push('PMD');
                if (connectedDevice.psFtpService)
                    services.push('PFTP');
            }
            catch (e) {
                console.warn('Error checking services:', e);
            }
        }
        const details = gattConnected
            ? `✅ GATT connected with ${services.length} service(s) available`
            : `⚠️ Device in app but GATT NOT connected. Browser paired: ${browserPaired}`;
        console.log('📊 Connection Status:', {
            connected: true,
            gattConnected,
            deviceName,
            services,
            browserPaired,
            details
        });
        return {
            connected: true,
            gattConnected,
            deviceName,
            services,
            browserPaired,
            details
        };
    }
    async isFtuDone(options) {
        var _a;
        console.log('🔍 Checking FTU status...');
        const connectedDevice = this.devices.get(options.identifier);
        if (!connectedDevice) {
            console.warn('❌ Device not found in app - cannot check FTU');
            return {
                done: false,
                message: '❌ Device not connected in app. Click "Connect" first.'
            };
        }
        // Check if GATT is actually connected
        if (!((_a = connectedDevice.gattServer) === null || _a === void 0 ? void 0 : _a.connected)) {
            console.warn('⚠️ GATT not connected - cannot check FTU status');
            return {
                done: false,
                message: '⚠️ GATT not connected. Device paired but not active.'
            };
        }
        // Try to actually check by reading the user identifier file
        try {
            console.log('🔍 Checking FTU status by reading USERID.BPB...');
            if (!connectedDevice.psFtpService) {
                const gattServer = connectedDevice.gattServer;
                connectedDevice.psFtpService = await gattServer.getPrimaryService(PSFTP_SERVICE);
            }
            if (!connectedDevice.psFtpMtuCharacteristic) {
                connectedDevice.psFtpMtuCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_MTU_CHARACTERISTIC);
            }
            if (!connectedDevice.psFtpD2HCharacteristic) {
                connectedDevice.psFtpD2HCharacteristic = await connectedDevice.psFtpService.getCharacteristic(PSFTP_D2H_NOTIFICATION);
            }
            const pftpClient = new PftpClient(connectedDevice.psFtpMtuCharacteristic, connectedDevice.psFtpD2HCharacteristic, connectedDevice.psFtpH2DCharacteristic);
            await pftpClient.initialize();
            // Try to read the user identifier file
            const USER_ID_PATH = '/U/0/USERID.BPB';
            const operation = createPftpOperation('GET', USER_ID_PATH);
            try {
                await pftpClient.sendQuery(0, operation); // GET query
                console.log('✅ FTU is DONE (USERID.BPB exists)');
                this.ftuStatusMap.set(options.identifier, true);
                connectedDevice.ftuCompleted = true;
                return {
                    done: true,
                    message: '✅ FTU completed! USERID.BPB exists on device.'
                };
            }
            catch (error) {
                console.log('❌ FTU is NOT done (USERID.BPB does not exist)');
                return {
                    done: false,
                    message: '❌ FTU not done. USERID.BPB file not found on device.'
                };
            }
        }
        catch (error) {
            console.error('Error checking FTU status:', error);
            // Fall back to cached status
            const done = this.ftuStatusMap.get(options.identifier) || connectedDevice.ftuCompleted || false;
            console.log(`Falling back to cached FTU status: ${done}`);
            return {
                done,
                message: `⚠️ Could not verify on device. Cached status: ${done ? 'Done' : 'Not done'}. Error: ${error.message}`
            };
        }
    }
    async deleteStoredDeviceData(options) {
        console.log('deleteStoredDeviceData', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async deleteDeviceDateFolders(options) {
        console.log('deleteDeviceDateFolders', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async getSteps(options) {
        console.log('getSteps', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async getDistance(options) {
        console.log('getDistance', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async getActiveTime(options) {
        console.log('getActiveTime', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async getActivitySampleData(options) {
        console.log('getActivitySampleData', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async sendInitializationAndStartSyncNotifications(options) {
        console.log('sendInitializationAndStartSyncNotifications', options);
        throw this.unimplemented('Not implemented on web.');
    }
    async sendTerminateAndStopSyncNotifications(options) {
        console.log('sendTerminateAndStopSyncNotifications', options);
        throw this.unimplemented('Not implemented on web.');
    }
}
//# sourceMappingURL=web.js.map