var capacitorPolarSdk = (function (exports, core, protobuf) {
    'use strict';

    exports.PolarDataType = void 0;
    (function (PolarDataType) {
        PolarDataType[PolarDataType["HR"] = 0] = "HR";
        PolarDataType[PolarDataType["ECG"] = 1] = "ECG";
        PolarDataType[PolarDataType["ACC"] = 2] = "ACC";
        PolarDataType[PolarDataType["PPG"] = 3] = "PPG";
        PolarDataType[PolarDataType["PPI"] = 4] = "PPI";
        PolarDataType[PolarDataType["GYRO"] = 5] = "GYRO";
        PolarDataType[PolarDataType["MAGNETOMETER"] = 6] = "MAGNETOMETER";
        PolarDataType[PolarDataType["TEMPERATURE"] = 7] = "TEMPERATURE";
        PolarDataType[PolarDataType["PRESSURE"] = 8] = "PRESSURE";
    })(exports.PolarDataType || (exports.PolarDataType = {}));
    exports.RecordingInterval = void 0;
    (function (RecordingInterval) {
        RecordingInterval[RecordingInterval["INTERVAL_1S"] = 0] = "INTERVAL_1S";
        RecordingInterval[RecordingInterval["INTERVAL_5S"] = 1] = "INTERVAL_5S";
    })(exports.RecordingInterval || (exports.RecordingInterval = {}));
    exports.SampleType = void 0;
    (function (SampleType) {
        SampleType[SampleType["HR"] = 0] = "HR";
        SampleType[SampleType["RR"] = 1] = "RR";
    })(exports.SampleType || (exports.SampleType = {}));

    const PolarSdk = core.registerPlugin('PolarSdk', {
        web: () => Promise.resolve().then(function () { return web; }).then(m => new m.PolarSdkWeb()),
    });

    /**
     * Polar File Transfer Protocol (PFTP) Client for Web Bluetooth
     * Implements RFC-76 framing and file operations
     */
    class PftpClient {
        constructor(mtuChar, d2hChar, _h2dChar) {
            this.sequenceNumber = 0;
            this.resetSequenceAfterWrite = true;
            this.responseBuffer = [];
            this.responsePromise = null;
            this.mtu = 512; // Default MTU
            this.mtuCharacteristic = mtuChar;
            this.d2hCharacteristic = d2hChar;
        }
        async initialize() {
            console.log('Setting up MTU notification listener...');
            this.mtuCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                console.log('📨 MTU characteristicvaluechanged event fired');
                this.handleMTUNotification(event.target.value);
            });
            console.log('Starting MTU notifications...');
            await this.mtuCharacteristic.startNotifications();
            console.log('Setting up D2H notification listener...');
            this.d2hCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                console.log('📨 D2H characteristicvaluechanged event fired');
                this.handleD2HNotification(event.target.value);
            });
            console.log('Starting D2H notifications...');
            await this.d2hCharacteristic.startNotifications();
            console.log('✅ PFTP client initialized - MTU and D2H notifications active');
        }
        /**
         * Send PFTP query via MTU characteristic
         * Used for queries like SET_LOCAL_TIME, GET_LOCAL_TIME, etc.
         */
        async sendQuery(queryId, params) {
            console.log(`PFTP: Sending query ID ${queryId}`);
            // RFC-60 query format: [query_id_low][query_id_high|0x80][params...]
            const header = new Uint8Array([
                queryId & 0xFF,
                ((queryId >> 8) & 0x7F) | 0x80
            ]);
            let message;
            if (params) {
                message = new Uint8Array(header.length + params.length);
                message.set(header, 0);
                message.set(params, header.length);
            }
            else {
                message = header;
            }
            console.log('PFTP: Query message:', Array.from(message).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
            const queryPromise = this.waitForResponse();
            await this.sendRequest(message);
            console.log('PFTP: Query sent, waiting for response...');
            const response = await queryPromise;
            console.log(`PFTP: Query response: ${response.length} bytes`);
            return response;
        }
        /**
         * Write a file to the device using PFTP PUT operation
         */
        async writeFile(path, data, operation) {
            console.log(`PFTP: Writing file to ${path} (${data.length} bytes)`);
            console.log(`PFTP: Operation packet: ${operation.length} bytes`);
            console.log('PFTP: Skipping session initialization for Polar 360 (not supported)');
            await new Promise(resolve => setTimeout(resolve, 100));
            // Combine operation header and data into single message with RFC-60 framing
            // RFC-60 format: [header_size_low][header_size_high][operation_bytes][data_bytes]
            const headerSize = operation.length;
            const completeMessage = new Uint8Array(2 + headerSize + data.length);
            completeMessage[0] = headerSize & 0xFF;
            completeMessage[1] = (headerSize >> 8) & 0x7F;
            completeMessage.set(operation, 2);
            completeMessage.set(data, 2 + headerSize);
            console.log(`PFTP: Sending complete message (${completeMessage.length} bytes)...`);
            console.log(`PFTP: RFC-60 header: size=${headerSize} [0x${completeMessage[0].toString(16).padStart(2, '0')} 0x${completeMessage[1].toString(16).padStart(2, '0')}]`);
            const writePromise = this.waitForResponse();
            await this.sendRequest(completeMessage);
            console.log('PFTP: Complete message sent via MTU, waiting for response...');
            const response = await writePromise;
            console.log(`PFTP: Write response: ${response.length} bytes`);
            this.checkResponse(response);
            console.log('✅ PFTP: File written successfully!');
            console.log('PFTP: Skipping session termination for Polar 360 (not supported)');
            // Reset sequence number after successful write
            if (this.resetSequenceAfterWrite) {
                console.log('PFTP: Resetting sequence number to 0');
                this.sequenceNumber = 0;
            }
        }
        /**
         * Send PFTP request via MTU characteristic with RFC-76 framing
         * Used for GET/PUT operations
         */
        async sendRequest(data) {
            const maxPayload = this.mtu - 1;
            if (maxPayload <= 0) {
                throw new Error(`Invalid MTU: ${this.mtu}`);
            }
            const totalPackets = Math.ceil(data.length / maxPayload);
            console.log(`PFTP MTU: Sending ${data.length} bytes in ${totalPackets} packets (MTU: ${this.mtu}, maxPayload: ${maxPayload})`);
            console.log('PFTP: First 32 bytes:', Array.from(data.slice(0, 32)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
            for (let i = 0; i < totalPackets; i++) {
                const start = i * maxPayload;
                const end = Math.min(start + maxPayload, data.length);
                const chunk = data.slice(start, end);
                const isLast = i === totalPackets - 1;
                const next = (i === 0) ? 0 : 1;
                const status = isLast ? 1 : 2;
                const header = (this.sequenceNumber << 4) | (status << 1) | next;
                const packet = new Uint8Array(1 + chunk.length);
                packet[0] = header;
                packet.set(chunk, 1);
                console.log(`PFTP MTU: Packet ${i + 1}/${totalPackets} [seq:${this.sequenceNumber}, status:${status}, next:${next}] - ${packet.length} bytes`);
                await this.mtuCharacteristic.writeValue(packet);
                if (this.sequenceNumber < 15) {
                    this.sequenceNumber++;
                }
                else {
                    this.sequenceNumber = 0;
                }
                if (!isLast) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
            console.log('PFTP: All packets sent via MTU');
        }
        /**
         * Handle MTU notifications (for query/request responses)
         * RFC-76 frame format:
         * Byte 0: [sequence:4bits][status:2bits][next:1bit]
         */
        handleMTUNotification(value) {
            const data = new Uint8Array(value.buffer);
            console.log('🔵 PFTP MTU:', data.length, 'bytes:', Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
            this.processRFC76Response(data);
        }
        /**
         * Handle D2H notifications (for device notifications)
         * RFC-76 frame format:
         * Byte 0: [sequence:4bits][status:2bits][next:1bit]
         */
        handleD2HNotification(value) {
            const data = new Uint8Array(value.buffer);
            console.log('🔵 PFTP D2H:', data.length, 'bytes:', Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
            this.processRFC76Response(data);
        }
        /**
         * Process RFC-76 response (common for MTU and D2H)
         * Error response: [header][error_low][error_high] (3 bytes)
         * Data response: [header][payload...]
         */
        processRFC76Response(data) {
            if (data.length === 0) {
                console.log('PFTP: Empty response (success)');
                const promise = this.responsePromise;
                this.responsePromise = null;
                this.responseBuffer = [];
                if (promise) {
                    promise.resolve(new Uint8Array(0));
                }
                return;
            }
            const header = data[0];
            const next = header & 0x01;
            const status = (header & 0x06) >> 1;
            const sequence = header >> 4;
            console.log(`RFC76: seq=${sequence}, status=${status}, next=${next}`);
            const RFC76_STATUS_ERROR_OR_RESPONSE = 0;
            const RFC76_STATUS_LAST = 1;
            if (status === RFC76_STATUS_ERROR_OR_RESPONSE) {
                if (data.length >= 3) {
                    const errorCode = data[1] | (data[2] << 8);
                    if (errorCode === 0) {
                        console.log('✅ PFTP: Success response (error code 0)');
                        const promise = this.responsePromise;
                        this.responsePromise = null;
                        this.responseBuffer = [];
                        if (promise) {
                            promise.resolve(new Uint8Array(0));
                        }
                    }
                    else {
                        console.error(`❌ PFTP ERROR: code=${errorCode} (0x${errorCode.toString(16)})`);
                        const promise = this.responsePromise;
                        this.responsePromise = null;
                        this.responseBuffer = [];
                        if (promise) {
                            promise.reject(new Error(`PFTP error code: ${errorCode}`));
                        }
                    }
                }
                else if (data.length === 1) {
                    console.log('✅ PFTP: Success response (header only)');
                    const promise = this.responsePromise;
                    this.responsePromise = null;
                    this.responseBuffer = [];
                    if (promise) {
                        promise.resolve(new Uint8Array(0));
                    }
                }
                else {
                    console.warn('PFTP: Unexpected error response length:', data.length);
                    const promise = this.responsePromise;
                    this.responsePromise = null;
                    this.responseBuffer = [];
                    if (promise) {
                        promise.resolve(data);
                    }
                }
                return;
            }
            if (data.length > 1) {
                const payload = data.slice(1);
                this.responseBuffer.push(payload);
            }
            if (status === RFC76_STATUS_LAST || next === 0) {
                const totalLength = this.responseBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
                const combined = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of this.responseBuffer) {
                    combined.set(chunk, offset);
                    offset += chunk.length;
                }
                console.log(`PFTP: Complete response: ${combined.length} bytes`);
                const promise = this.responsePromise;
                this.responsePromise = null;
                this.responseBuffer = [];
                if (promise) {
                    promise.resolve(combined);
                }
                else {
                    console.warn('PFTP: Response received but no promise waiting');
                }
            }
        }
        /**
         * Wait for response from device
         */
        waitForResponse(timeout = 10000) {
            return new Promise((resolve, reject) => {
                this.responsePromise = { resolve, reject };
                setTimeout(() => {
                    if (this.responsePromise) {
                        this.responsePromise.reject(new Error('PFTP operation timeout'));
                        this.responsePromise = null;
                        this.responseBuffer = [];
                    }
                }, timeout);
            });
        }
        /**
         * Check PFTP response for errors
         */
        checkResponse(response) {
            if (response.length === 0) {
                return; // Empty response = success
            }
            // Short responses like 0x02 0x07 are errors
            if (response.length === 2) {
                const errorType = response[0];
                const errorCode = response[1];
                console.error(`PFTP error: type=${errorType}, code=${errorCode}`);
                throw new Error(`PFTP error: type=${errorType}, code=${errorCode}`);
            }
            // Check for longer error response
            if (response.length >= 4) {
                const view = new DataView(response.buffer);
                const errorCode = view.getUint32(0, true);
                if (errorCode !== 0) {
                    throw new Error(`PFTP error code: ${errorCode}`);
                }
            }
        }
        /**
         * Clean up resources
         */
        async cleanup() {
            try {
                await this.d2hCharacteristic.stopNotifications();
            }
            catch (error) {
                console.warn('Failed to stop PFTP notifications:', error);
            }
        }
    }

    /**
     * Polar Protocol Buffer Definitions for Web Bluetooth
     * Based on native Polar SDK protobuf schemas
     */
    // PFTP Protocol Definitions
    const pftpProto = `
syntax = "proto2";

package PftpRequest;

message PbPFtpOperation {
  enum Command {
    GET = 0;
    PUT = 1;
  }
  required Command command = 1;
  required string path = 2;
}

message PbPFtpError {
  required uint32 error = 1;
}

message PbDate {
  required uint32 year = 1;
  required uint32 month = 2;
  required uint32 day = 3;
}

message PbTime {
  required uint32 hour = 1;
  required uint32 minute = 2;
  required uint32 seconds = 3;
  optional uint32 millis = 4;
}

message PbPFtpSetLocalTimeParams {
  required PbDate date = 1;
  required PbTime time = 2;
  optional int32 tz_offset = 3;
}
`;
    // User Identifier Protocol Definition
    const userIdSchema = {
        nested: {
            UserData: {
                nested: {
                    PbDate: {
                        fields: {
                            year: { type: 'uint32', id: 1, rule: 'required' },
                            month: { type: 'uint32', id: 2, rule: 'required' },
                            day: { type: 'uint32', id: 3, rule: 'required' }
                        }
                    },
                    PbTime: {
                        fields: {
                            hour: { type: 'uint32', id: 1, rule: 'required' },
                            minute: { type: 'uint32', id: 2, rule: 'required' },
                            second: { type: 'uint32', id: 3, rule: 'required' },
                            millis: { type: 'uint32', id: 4, rule: 'optional' },
                            tz_offset: { type: 'int32', id: 5, rule: 'optional' }
                        }
                    },
                    PbSystemDateTime: {
                        fields: {
                            date: { type: 'PbDate', id: 1, rule: 'required' },
                            time: { type: 'PbTime', id: 2, rule: 'required' },
                            trusted: { type: 'bool', id: 3, rule: 'required' }
                        }
                    },
                    PbUserIdentifier: {
                        fields: {
                            master_identifier: { type: 'uint64', id: 1, rule: 'required' },
                            user_id_last_modified: { type: 'PbSystemDateTime', id: 100, rule: 'optional' }
                        }
                    }
                }
            }
        }
    };
    // FTU Config Protocol Definitions using JSON (more reliable)
    const ftuSchema = {
        nested: {
            PolarUserData: {
                nested: {
                    PbDate: {
                        fields: {
                            year: { type: 'uint32', id: 1, rule: 'required' },
                            month: { type: 'uint32', id: 2, rule: 'required' },
                            day: { type: 'uint32', id: 3, rule: 'required' }
                        }
                    },
                    PbTime: {
                        fields: {
                            hour: { type: 'uint32', id: 1, rule: 'required' },
                            minute: { type: 'uint32', id: 2, rule: 'required' },
                            second: { type: 'uint32', id: 3, rule: 'required' },
                            millis: { type: 'uint32', id: 4, rule: 'optional' },
                            tz_offset: { type: 'int32', id: 5, rule: 'optional' }
                        }
                    },
                    PbSystemDateTime: {
                        fields: {
                            date: { type: 'PbDate', id: 1, rule: 'required' },
                            time: { type: 'PbTime', id: 2, rule: 'required' },
                            trusted: { type: 'bool', id: 3, rule: 'required' }
                        }
                    },
                    PbGender: {
                        values: {
                            MALE: 0,
                            FEMALE: 1
                        }
                    },
                    PbTypicalDay: {
                        values: {
                            MOSTLY_SITTING: 1,
                            MOSTLY_STANDING: 2,
                            MOSTLY_MOVING: 3
                        }
                    },
                    PbUserPhysData: {
                        fields: {
                            gender: { type: 'PbGender', id: 1, rule: 'required' },
                            birthDate: { type: 'PbDate', id: 2, rule: 'required' },
                            weight: { type: 'float', id: 3, rule: 'required' },
                            height: { type: 'float', id: 4, rule: 'required' },
                            maxHeartRate: { type: 'uint32', id: 5, rule: 'required' },
                            vo2Max: { type: 'uint32', id: 6, rule: 'required' },
                            restingHeartRate: { type: 'uint32', id: 7, rule: 'required' },
                            trainingBackground: { type: 'uint32', id: 8, rule: 'required' },
                            typicalDay: { type: 'PbTypicalDay', id: 9, rule: 'required' },
                            sleepGoal: { type: 'uint32', id: 10, rule: 'required' },
                            lastModified: { type: 'PbSystemDateTime', id: 11, rule: 'required' }
                        }
                    }
                }
            }
        }
    };
    // Create root
    let pftpRoot;
    let ftuRoot;
    let userIdRoot;
    const initProtobuf = () => {
        try {
            pftpRoot = protobuf.parse(pftpProto).root;
            ftuRoot = protobuf.Root.fromJSON(ftuSchema);
            userIdRoot = protobuf.Root.fromJSON(userIdSchema);
            console.log('Protocol Buffers initialized successfully');
            // Debug: Log what types were created
            const physData = ftuRoot.lookupType('PolarUserData.PbUserPhysData');
            console.log('FTU protobuf type created:', physData);
            console.log('Available fields:', Object.keys(physData.fields));
        }
        catch (error) {
            console.error('Failed to initialize protobuf:', error);
            throw error;
        }
    };
    const createPftpOperation = (command, path) => {
        if (!pftpRoot)
            initProtobuf();
        const PbPFtpOperation = pftpRoot.lookupType('PftpRequest.PbPFtpOperation');
        const message = PbPFtpOperation.create({
            command: command === 'GET' ? 0 : 1,
            path: path
        });
        return PbPFtpOperation.encode(message).finish();
    };
    const encodeFtuConfig = (config) => {
        if (!ftuRoot)
            initProtobuf();
        const PbUserPhysData = ftuRoot.lookupType('PolarUserData.PbUserPhysData');
        console.log('Protobuf type fields:', PbUserPhysData.fields);
        console.log('Input config:', config);
        // Parse birth date
        const birthDate = new Date(config.birthDate);
        console.log('Birth date parsed:', birthDate);
        // Parse device time
        const deviceTime = new Date(config.deviceTime);
        const tzOffset = -deviceTime.getTimezoneOffset(); // Convert to minutes
        console.log('Device time parsed:', deviceTime, 'TZ offset:', tzOffset);
        const messageData = {
            gender: config.gender === 'MALE' ? 0 : 1,
            birthDate: {
                year: birthDate.getFullYear(),
                month: birthDate.getMonth() + 1,
                day: birthDate.getDate()
            },
            weight: config.weight,
            height: config.height,
            maxHeartRate: config.maxHeartRate,
            vo2Max: config.vo2Max,
            restingHeartRate: config.restingHeartRate,
            trainingBackground: config.trainingBackground,
            typicalDay: config.typicalDay,
            sleepGoal: config.sleepGoalMinutes,
            lastModified: {
                date: {
                    year: deviceTime.getFullYear(),
                    month: deviceTime.getMonth() + 1,
                    day: deviceTime.getDate()
                },
                time: {
                    hour: deviceTime.getHours(),
                    minute: deviceTime.getMinutes(),
                    second: deviceTime.getSeconds(),
                    millis: deviceTime.getMilliseconds(),
                    tz_offset: tzOffset
                },
                trusted: true
            }
        };
        console.log('Creating protobuf message with data:', messageData);
        const message = PbUserPhysData.create(messageData);
        console.log('Message created:', message);
        console.log('Message fields:', JSON.stringify(message, null, 2));
        // Verify the message
        const errMsg = PbUserPhysData.verify(message);
        if (errMsg) {
            console.error('Protobuf verification failed:', errMsg);
            throw new Error(`Invalid FTU message: ${errMsg}`);
        }
        console.log('Message verified successfully');
        const encoded = PbUserPhysData.encode(message).finish();
        console.log('Encoded to', encoded.length, 'bytes:', Array.from(encoded).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
        // Try to decode it back to verify
        try {
            const decoded = PbUserPhysData.decode(encoded);
            console.log('Decode test successful:', decoded);
        }
        catch (error) {
            console.error('Decode test failed:', error);
        }
        return encoded;
    };
    const encodeUserIdentifier = (deviceTime) => {
        if (!userIdRoot)
            initProtobuf();
        const PbUserIdentifier = userIdRoot.lookupType('UserData.PbUserIdentifier');
        const now = new Date(deviceTime);
        const tzOffset = -now.getTimezoneOffset();
        const messageData = {
            master_identifier: '18446744073709551615',
            user_id_last_modified: {
                date: {
                    year: now.getFullYear(),
                    month: now.getMonth() + 1,
                    day: now.getDate()
                },
                time: {
                    hour: now.getHours(),
                    minute: now.getMinutes(),
                    second: now.getSeconds(),
                    millis: now.getMilliseconds(),
                    tz_offset: tzOffset
                },
                trusted: true
            }
        };
        console.log('Creating user identifier protobuf:', messageData);
        const message = PbUserIdentifier.create(messageData);
        const encoded = PbUserIdentifier.encode(message).finish();
        console.log('User identifier encoded to', encoded.length, 'bytes');
        return encoded;
    };
    const encodeSetLocalTimeParams = (time) => {
        if (!pftpRoot)
            initProtobuf();
        const PbPFtpSetLocalTimeParams = pftpRoot.lookupType('PftpRequest.PbPFtpSetLocalTimeParams');
        const tzOffset = -time.getTimezoneOffset();
        const messageData = {
            date: {
                year: time.getFullYear(),
                month: time.getMonth() + 1,
                day: time.getDate()
            },
            time: {
                hour: time.getHours(),
                minute: time.getMinutes(),
                seconds: time.getSeconds(),
                millis: time.getMilliseconds()
            },
            tz_offset: tzOffset
        };
        console.log('Creating setLocalTime params:', messageData);
        const message = PbPFtpSetLocalTimeParams.create(messageData);
        const encoded = PbPFtpSetLocalTimeParams.encode(message).finish();
        console.log('SetLocalTime params encoded to', encoded.length, 'bytes');
        return encoded;
    };

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
    class PolarSdkWeb extends core.WebPlugin {
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
                await this.stopStreaming({ identifier: options.identifier, feature: exports.PolarDataType.HR });
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
            const types = [exports.PolarDataType.HR, exports.PolarDataType.PPI];
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
                this.notifyListeners('sdkFeatureReady', { identifier: options.identifier, feature: exports.PolarDataType.HR });
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
                connectedDevice.streamingFeatures.add(exports.PolarDataType.PPI);
                this.notifyListeners('sdkFeatureReady', { identifier: options.identifier, feature: exports.PolarDataType.PPI });
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
                if (options.feature === exports.PolarDataType.HR && connectedDevice.heartRateCharacteristic) {
                    await connectedDevice.heartRateCharacteristic.stopNotifications();
                    connectedDevice.isStreaming = false;
                }
                else if (options.feature === exports.PolarDataType.PPI && connectedDevice.pmdCpCharacteristic) {
                    const stopCommand = new Uint8Array([
                        PMD_COMMAND.STOP_MEASUREMENT,
                        PMD_MEASUREMENT_TYPE.PPI,
                    ]);
                    await connectedDevice.pmdCpCharacteristic.writeValue(stopCommand);
                    connectedDevice.streamingFeatures.delete(exports.PolarDataType.PPI);
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
                case exports.PolarDataType.HR: return 'HR';
                case exports.PolarDataType.ECG: return 'ECG';
                case exports.PolarDataType.ACC: return 'ACC';
                case exports.PolarDataType.PPG: return 'PPG';
                case exports.PolarDataType.PPI: return 'PPI';
                case exports.PolarDataType.GYRO: return 'GYRO';
                case exports.PolarDataType.MAGNETOMETER: return 'MAG';
                case exports.PolarDataType.TEMPERATURE: return 'TEMP';
                case exports.PolarDataType.PRESSURE: return 'PRESS';
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
            const types = [exports.PolarDataType.PPI, exports.PolarDataType.ACC, exports.PolarDataType.PPG];
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
                if (options.feature === exports.PolarDataType.ACC) {
                    measurementType = PMD_MEASUREMENT_TYPE.ACC;
                }
                else if (options.feature === exports.PolarDataType.PPG) {
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
                if (options.feature === exports.PolarDataType.ACC) {
                    measurementType = PMD_MEASUREMENT_TYPE.ACC;
                }
                else if (options.feature === exports.PolarDataType.PPG) {
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

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        PolarSdkWeb: PolarSdkWeb
    });

    exports.PolarSdk = PolarSdk;

    return exports;

})({}, capacitorExports, protobuf);
//# sourceMappingURL=plugin.js.map
