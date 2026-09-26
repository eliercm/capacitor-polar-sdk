import Foundation
import PolarBleSdk
import RxSwift
import CoreBluetooth
import Capacitor

@objc(PolarSdk)
class PolarSdk : CAPPlugin, ObservableObject {
    private var api = PolarBleApiDefaultImpl.polarImplementation(DispatchQueue.main,
                                                                 features: Set(PolarBleSdkFeature.allCases))
    
    @Published var isBluetoothOn: Bool = true
    @Published var deviceConnectionState: [String: DeviceConnectionState] = [:]
    
    private var onlineStreamingDisposables: [String: [PolarDeviceDataType: Disposable?]] = [:]
    private var searchDisposable: Disposable?
    private let disposeBag = DisposeBag()
    
  override init() {
        super.init()
        self.isBluetoothOn = api.isBlePowered
        api.polarFilter(true)
        api.observer = self
        api.deviceFeaturesObserver = self
        api.powerStateObserver = self
        api.deviceInfoObserver = self
        api.logger = self
    }
    
    @objc func connectToDevice(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        do {
            try api.connectToDevice(identifier)
            call.resolve()
        } catch let err {
            call.reject("Failed to connect to \(identifier). Reason \(err)")
        }
    }
    
    @objc func disconnectFromDevice(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        do {
            try api.disconnectFromDevice(identifier)
            call.resolve()
        } catch let err {
            call.reject("Failed to disconnect from \(identifier). Reason \(err)")
        }
    }
    
    @objc func searchForDevice(_ call: CAPPluginCall) {
        searchDisposable?.dispose()
        searchDisposable = api.searchForDevice()
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { deviceInfo in
                    var data = JSObject()
                    data["deviceId"] = deviceInfo.deviceId
                    data["address"] = deviceInfo.address.uuidString
                    data["rssi"] = deviceInfo.rssi
                    data["name"] = deviceInfo.name
                    data["isConnectable"] = deviceInfo.connectable
                    self.notifyListeners("deviceFound", data: data)
                },
                onError: { error in
                    call.reject("Search failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func getAvailableOnlineStreamDataTypes(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.getAvailableOnlineStreamDataTypes(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { dataTypes in
                    let types = dataTypes.compactMap { Self.jsCode(for: $0) }
                    call.resolve(["types": types])
                },
                onFailure: { error in
                    call.reject("Failed to get available data types: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func requestStreamSettings(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let featureIndex = call.getInt("feature"),
              let feature = Self.dataType(forJsCode: featureIndex) else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        api.requestStreamSettings(identifier, feature: feature)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { settings in
                    var settingsDict: [String: [Int]] = [:]
                    for (key, values) in settings.settings {
                        settingsDict[String(describing: key)] = values.map { Int($0) }
                    }
                    call.resolve(["settings": settingsDict])
                },
                onFailure: { error in
                    call.reject("Failed to request stream settings: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func startHrStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.hr] = api.startHrStreaming(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { hrData in
                    for sample in hrData {
                        var data = JSObject()
                        data["bpm"] = Int(sample.hr)
                        data["rrs"] = sample.rrsMs
                        data["timestamp"] = Int(Date().timeIntervalSince1970 * 1000)
                        self.notifyListeners("hrData", data: data)
                    }
                },
                onError: { error in
                    call.reject("HR stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startEcgStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        guard let settings = parseSettings(call.getObject("settings"),
                                          fallback: [.sampleRate: 130, .resolution: 14]) else {
            call.reject("Invalid stream settings")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.ecg] = api.startEcgStreaming(identifier, settings: settings)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { ecgData in
                    // Mirror Android's `gson.toJson(PolarEcgData)` payload exactly:
                    // {"samples":[{"timeStamp":<ns>,"voltage":<uV>}, ...]}
                    let samples = ecgData.map { ["timeStamp": Int($0.timeStamp), "voltage": Int($0.voltage)] }
                    guard let encoded = try? JSONSerialization.data(withJSONObject: ["samples": samples]),
                          let json = String(data: encoded, encoding: .utf8) else { return }
                    var data = JSObject()
                    data["data"] = json
                    self.notifyListeners("ecgData", data: data)
                },
                onError: { error in
                    call.reject("ECG stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startAccStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        guard let settings = parseSettings(call.getObject("settings"), fallback: [:]) else {
            call.reject("Invalid stream settings")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.acc] = api.startAccStreaming(identifier, settings: settings)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { accData in
                    for sample in accData {
                        var data = JSObject()
                        data["x"] = Int(sample.x)
                        data["y"] = Int(sample.y)
                        data["z"] = Int(sample.z)
                        data["timestamp"] = Int(sample.timeStamp)
                        self.notifyListeners("accData", data: data)
                    }
                },
                onError: { error in
                    call.reject("ACC stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startGyroStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        guard let settings = parseSettings(call.getObject("settings"), fallback: [:]) else {
            call.reject("Invalid stream settings")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.gyro] = api.startGyroStreaming(identifier, settings: settings)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { gyroData in
                    for sample in gyroData {
                        var data = JSObject()
                        data["x"] = sample.x
                        data["y"] = sample.y
                        data["z"] = sample.z
                        data["timestamp"] = Int(sample.timeStamp)
                        self.notifyListeners("gyroData", data: data)
                    }
                },
                onError: { error in
                    call.reject("Gyro stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startMagnetometerStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        guard let settings = parseSettings(call.getObject("settings"), fallback: [:]) else {
            call.reject("Invalid stream settings")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.magnetometer] = api.startMagnetometerStreaming(identifier, settings: settings)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { magData in
                    for sample in magData {
                        var data = JSObject()
                        data["x"] = sample.x
                        data["y"] = sample.y
                        data["z"] = sample.z
                        data["timestamp"] = Int(sample.timeStamp)
                        self.notifyListeners("magnetometerData", data: data)
                    }
                },
                onError: { error in
                    call.reject("Magnetometer stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startPpgStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        guard let settings = parseSettings(call.getObject("settings"), fallback: [:]) else {
            call.reject("Invalid stream settings")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.ppg] = api.startPpgStreaming(identifier, settings: settings)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { ppgData in
                    for sample in ppgData.samples {
                        var data = JSObject()
                        data["ppg0"] = sample.channelSamples.count > 0 ? Int(sample.channelSamples[0]) : 0
                        data["ppg1"] = sample.channelSamples.count > 1 ? Int(sample.channelSamples[1]) : 0
                        data["ppg2"] = sample.channelSamples.count > 2 ? Int(sample.channelSamples[2]) : 0
                        data["ambient"] = sample.channelSamples.count > 3 ? Int(sample.channelSamples[3]) : 0
                        data["timestamp"] = Int(sample.timeStamp)
                        self.notifyListeners("ppgData", data: data)
                    }
                },
                onError: { error in
                    call.reject("PPG stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startPpiStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.ppi] = api.startPpiStreaming(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { ppiData in
                    for sample in ppiData.samples {
                        var data = JSObject()
                        data["ppInMs"] = Int(sample.ppInMs)
                        data["hr"] = sample.hr
                        data["blockerBit"] = sample.blockerBit
                        data["errorEstimate"] = Int(sample.ppErrorEstimate)
                        self.notifyListeners("ppiData", data: data)
                    }
                },
                onError: { error in
                    call.reject("PPI stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startTemperatureStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        guard let settings = parseSettings(call.getObject("settings"), fallback: [:]) else {
            call.reject("Invalid stream settings")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.temperature] = api.startTemperatureStreaming(identifier, settings: settings)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { tempData in
                    for sample in tempData.samples {
                        var data = JSObject()
                        data["temperature"] = sample.temperature
                        data["timestamp"] = Int(sample.timeStamp)
                        self.notifyListeners("temperatureData", data: data)
                    }
                },
                onError: { error in
                    call.reject("Temperature stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func startPressureStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        guard let settings = parseSettings(call.getObject("settings"), fallback: [:]) else {
            call.reject("Invalid stream settings")
            return
        }
        
        if onlineStreamingDisposables[identifier] == nil {
            onlineStreamingDisposables[identifier] = [:]
        }
        
        onlineStreamingDisposables[identifier]?[.pressure] = api.startPressureStreaming(identifier, settings: settings)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { pressureData in
                    for sample in pressureData.samples {
                        var data = JSObject()
                        data["pressure"] = sample.pressure
                        data["timestamp"] = Int(sample.timeStamp)
                        self.notifyListeners("pressureData", data: data)
                    }
                },
                onError: { error in
                    call.reject("Pressure stream failed: \(error)")
                },
                onCompleted: {
                    call.resolve(["value": true])
                }
            )
    }
    
    @objc func stopStreaming(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let featureIndex = call.getInt("feature"),
              let feature = Self.dataType(forJsCode: featureIndex) else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        onlineStreamingDisposables[identifier]?[feature]??.dispose()
        call.resolve(["value": true])
    }
    
    @objc func startRecording(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let exerciseId = call.getString("exerciseId"),
              let intervalIndex = call.getInt("interval"),
              let sampleTypeIndex = call.getInt("sampleType") else {
            call.reject("Missing parameters")
            return
        }
        
        let interval = intervalIndex == 0 ? RecordingInterval.interval_1s : RecordingInterval.interval_5s
        let sampleType = sampleTypeIndex == 0 ? SampleType.hr : SampleType.rr
        
        api.startRecording(identifier, exerciseId: exerciseId, interval: interval, sampleType: sampleType)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to start recording: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func stopRecording(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.stopRecording(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to stop recording: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func requestRecordingStatus(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.requestRecordingStatus(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { status in
                    call.resolve([
                        "ongoing": status.ongoing,
                        "entryId": status.entryId
                    ])
                },
                onFailure: { error in
                    call.reject("Failed to get recording status: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func listExercises(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        var entries: [[String: Any]] = []
        api.fetchStoredExerciseList(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { entry in
                    let dateFormatter = ISO8601DateFormatter()
                    entries.append([
                        "path": entry.path,
                        "date": dateFormatter.string(from: entry.date),
                        "entryId": entry.entryId
                    ])
                },
                onError: { error in
                    call.reject("Failed to list exercises: \(error)")
                },
                onCompleted: {
                    call.resolve(["entries": entries])
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func fetchExercise(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let entryDict = call.getObject("entry"),
              let path = entryDict["path"] as? String,
              let dateString = entryDict["date"] as? String,
              let entryId = entryDict["entryId"] as? String else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        let dateFormatter = ISO8601DateFormatter()
        guard let date = dateFormatter.date(from: dateString) else {
            call.reject("Invalid date format")
            return
        }
        
        let entry = PolarExerciseEntry(path: path, date: date, entryId: entryId)
        
        api.fetchExercise(identifier, entry: entry)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { data in
                    call.resolve([
                        "interval": Int(data.interval),
                        "samples": data.samples.map { Int($0) }
                    ])
                },
                onFailure: { error in
                    call.reject("Failed to fetch exercise: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func removeExercise(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let entryDict = call.getObject("entry"),
              let path = entryDict["path"] as? String,
              let dateString = entryDict["date"] as? String,
              let entryId = entryDict["entryId"] as? String else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        let dateFormatter = ISO8601DateFormatter()
        guard let date = dateFormatter.date(from: dateString) else {
            call.reject("Invalid date format")
            return
        }
        
        let entry = PolarExerciseEntry(path: path, date: date, entryId: entryId)
        
        api.removeExercise(identifier, entry: entry)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to remove exercise: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func setLedConfig(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let configDict = call.getObject("config"),
              let enabled = configDict["ledEnabled"] as? Bool else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        let config = LedConfig(sdkModeLedEnabled: enabled, ppiModeLedEnabled: enabled)
        
        api.setLedConfig(identifier, ledConfig: config)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to set LED config: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func doFactoryReset(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let preservePairing = call.getBool("preservePairingInformation") else {
            call.reject("Missing parameters")
            return
        }
        
        api.doFactoryReset(identifier, preservePairingInformation: preservePairing)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to do factory reset: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func enableSdkMode(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.enableSDKMode(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to enable SDK mode: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func disableSdkMode(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.disableSDKMode(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to disable SDK mode: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func isSdkModeEnabled(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.isSDKModeEnabled(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { enabled in
                    call.resolve(["enabled": enabled])
                },
                onFailure: { error in
                    call.reject("Failed to check SDK mode: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getAvailableOfflineRecordingDataTypes(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.getAvailableOfflineRecordingDataTypes(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { dataTypes in
                    let types = dataTypes.compactMap { Self.jsCode(for: $0) }
                    call.resolve(["types": types])
                },
                onFailure: { error in
                    call.reject("Failed to get available offline recording data types: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func requestOfflineRecordingSettings(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let featureIndex = call.getInt("feature"),
              let feature = Self.dataType(forJsCode: featureIndex) else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        api.requestOfflineRecordingSettings(identifier, feature: feature)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { settings in
                    var settingsDict: [String: [Int]] = [:]
                    for (key, values) in settings.settings {
                        settingsDict[String(describing: key)] = values.map { Int($0) }
                    }
                    call.resolve(["settings": settingsDict])
                },
                onFailure: { error in
                    call.reject("Failed to request offline recording settings: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func startOfflineRecording(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let featureIndex = call.getInt("feature"),
              let feature = Self.dataType(forJsCode: featureIndex) else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        let settings = parseSettings(call.getObject("settings"))
        
        api.startOfflineRecording(identifier, feature: feature, settings: settings, secret: nil)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to start offline recording: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func stopOfflineRecording(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let featureIndex = call.getInt("feature"),
              let feature = Self.dataType(forJsCode: featureIndex) else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        api.stopOfflineRecording(identifier, feature: feature)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to stop offline recording: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getOfflineRecordingStatus(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.getOfflineRecordingStatus(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { status in
                    let features = status.compactMap { (key, value) -> Int? in
                        value ? Self.jsCode(for: key) : nil
                    }
                    call.resolve(["features": features])
                },
                onFailure: { error in
                    call.reject("Failed to get offline recording status: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func listOfflineRecordings(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        var entries: [[String: Any]] = []
        api.listOfflineRecordings(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onNext: { entry in
                    let dateFormatter = ISO8601DateFormatter()
                    entries.append([
                        "path": entry.path,
                        "size": entry.size,
                        "date": dateFormatter.string(from: entry.date),
                        "type": String(describing: entry.type)
                    ])
                },
                onError: { error in
                    call.reject("Failed to list offline recordings: \(error)")
                },
                onCompleted: {
                    call.resolve(["entries": entries])
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getOfflineRecord(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let entryDict = call.getObject("entry") else {
            call.reject("Missing parameters")
            return
        }
        
        guard let path = entryDict["path"] as? String,
              let size = entryDict["size"] as? Int,
              let dateString = entryDict["date"] as? String,
              let typeString = entryDict["type"] as? String else {
            call.reject("Invalid entry parameters")
            return
        }
        
        let dateFormatter = ISO8601DateFormatter()
        guard let date = dateFormatter.date(from: dateString) else {
            call.reject("Invalid date format")
            return
        }
        
        let entry = PolarOfflineRecordingEntry(path: path, size: UInt(size), date: date, type: Self.dataType(forJsName: typeString) ?? .acc)
        
        api.getOfflineRecord(identifier, entry: entry, secret: nil)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { recordingData in
                    var result: [String: Any] = [:]
                    switch recordingData {
                    case .accOfflineRecordingData(_, let startTime, let settings):
                        result["startTime"] = dateFormatter.string(from: startTime)
                        result["settings"] = Self.settingsDict(settings)
                    case .gyroOfflineRecordingData(_, let startTime, let settings):
                        result["startTime"] = dateFormatter.string(from: startTime)
                        result["settings"] = Self.settingsDict(settings)
                    case .magOfflineRecordingData(_, let startTime, let settings):
                        result["startTime"] = dateFormatter.string(from: startTime)
                        result["settings"] = Self.settingsDict(settings)
                    case .ppgOfflineRecordingData(_, let startTime, let settings):
                        result["startTime"] = dateFormatter.string(from: startTime)
                        result["settings"] = Self.settingsDict(settings)
                    case .ppiOfflineRecordingData(_, let startTime):
                        result["startTime"] = dateFormatter.string(from: startTime)
                    case .hrOfflineRecordingData(_, let startTime):
                        result["startTime"] = dateFormatter.string(from: startTime)
                    case .temperatureOfflineRecordingData(_, let startTime):
                        result["startTime"] = dateFormatter.string(from: startTime)
                    case .skinTemperatureOfflineRecordingData(_, let startTime):
                        result["startTime"] = dateFormatter.string(from: startTime)
                    case .emptyData(let startTime):
                        result["startTime"] = dateFormatter.string(from: startTime)
                    }
                    call.resolve(result)
                },
                onFailure: { error in
                    call.reject("Failed to get offline record: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func removeOfflineRecord(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let entryDict = call.getObject("entry"),
              let path = entryDict["path"] as? String,
              let size = entryDict["size"] as? Int,
              let dateString = entryDict["date"] as? String,
              let typeString = entryDict["type"] as? String else {
            call.reject("Missing or invalid parameters")
            return
        }
        
        let dateFormatter = ISO8601DateFormatter()
        guard let date = dateFormatter.date(from: dateString) else {
            call.reject("Invalid date format")
            return
        }
        
        let entry = PolarOfflineRecordingEntry(path: path, size: UInt(size), date: date, type: Self.dataType(forJsName: typeString) ?? .acc)
        
        api.removeOfflineRecord(identifier, entry: entry)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to remove offline record: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getDiskSpace(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.getDiskSpace(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { diskSpace in
                    call.resolve([
                        "freeSpace": diskSpace.freeSpace,
                        "totalSpace": diskSpace.totalSpace
                    ])
                },
                onFailure: { error in
                    call.reject("Failed to get disk space: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getLocalTime(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.getLocalTime(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { time in
                    let dateFormatter = ISO8601DateFormatter()
                    call.resolve(["time": dateFormatter.string(from: time)])
                },
                onFailure: { error in
                    call.reject("Failed to get local time: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func setLocalTime(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let timeString = call.getString("time") else {
            call.reject("Missing parameters")
            return
        }
        
        let dateFormatter = ISO8601DateFormatter()
        guard let time = dateFormatter.date(from: timeString) else {
            call.reject("Invalid time format")
            return
        }
        
        let timeZone = TimeZone.current
        
        api.setLocalTime(identifier, time: time, zone: timeZone)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to set local time: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func doFirstTimeUse(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let configDict = call.getObject("config") else {
            call.reject("Missing parameters")
            return
        }
        
        guard let genderStr = configDict["gender"] as? String,
              let birthDateStr = configDict["birthDate"] as? String,
              let height = configDict["height"] as? Int,
              let weight = configDict["weight"] as? Int,
              let maxHeartRate = configDict["maxHeartRate"] as? Int,
              let vo2Max = configDict["vo2Max"] as? Int,
              let restingHeartRate = configDict["restingHeartRate"] as? Int,
              let trainingBackground = configDict["trainingBackground"] as? Int,
              let deviceTime = configDict["deviceTime"] as? String,
              let typicalDay = configDict["typicalDay"] as? Int,
              let sleepGoalMinutes = configDict["sleepGoalMinutes"] as? Int else {
            call.reject("Invalid config parameters")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        guard let birthDate = dateFormatter.date(from: birthDateStr) else {
            call.reject("Invalid birth date format")
            return
        }
        
        let trainingBackgroundLevel: PolarFirstTimeUseConfig.TrainingBackground
        switch trainingBackground {
        case 10: trainingBackgroundLevel = .occasional
        case 20: trainingBackgroundLevel = .regular
        case 30: trainingBackgroundLevel = .frequent
        case 40: trainingBackgroundLevel = .heavy
        case 50: trainingBackgroundLevel = .semiPro
        case 60: trainingBackgroundLevel = .pro
        default: trainingBackgroundLevel = .occasional
        }
        
        let typicalDayEnum: PolarFirstTimeUseConfig.TypicalDay
        switch typicalDay {
        case 1: typicalDayEnum = .mostlyMoving
        case 2: typicalDayEnum = .mostlySitting
        case 3: typicalDayEnum = .mostlyStanding
        default: typicalDayEnum = .mostlySitting
        }
        
        let config = PolarFirstTimeUseConfig(
            gender: genderStr == "Male" ? .male : .female,
            birthDate: birthDate,
            height: Float(height),
            weight: Float(weight),
            maxHeartRate: maxHeartRate,
            vo2Max: vo2Max,
            restingHeartRate: restingHeartRate,
            trainingBackground: trainingBackgroundLevel,
            deviceTime: deviceTime,
            typicalDay: typicalDayEnum,
            sleepGoalMinutes: sleepGoalMinutes
        )
        
        api.doFirstTimeUse(identifier, ftuConfig: config)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to do first time use: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func isFtuDone(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.isFtuDone(identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { done in
                    call.resolve(["done": done])
                },
                onFailure: { error in
                    call.reject("Failed to check FTU status: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func deleteStoredDeviceData(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let dataTypeIndex = call.getInt("dataType"),
              let untilDateStr = call.getString("until") else {
            call.reject("Missing parameters")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        guard let untilDate = dateFormatter.date(from: untilDateStr) else {
            call.reject("Invalid date format")
            return
        }
        
        guard dataTypeIndex < PolarStoredDataType.StoredDataType.allCases.count else {
            call.reject("Invalid data type index")
            return
        }
        
        let dataType = PolarStoredDataType.StoredDataType.allCases[dataTypeIndex]
        
        api.deleteStoredDeviceData(identifier, dataType: dataType, until: untilDate)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to delete stored device data: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func deleteDeviceDateFolders(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let fromDateStr = call.getString("fromDate"),
              let toDateStr = call.getString("toDate") else {
            call.reject("Missing parameters")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        guard let fromDate = dateFormatter.date(from: fromDateStr),
              let toDate = dateFormatter.date(from: toDateStr) else {
            call.reject("Invalid date format")
            return
        }
        
        api.deleteDeviceDateFolders(identifier, fromDate: fromDate, toDate: toDate)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to delete device date folders: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getSteps(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let fromDateStr = call.getString("fromDate"),
              let toDateStr = call.getString("toDate") else {
            call.reject("Missing parameters")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        guard let fromDate = dateFormatter.date(from: fromDateStr),
              let toDate = dateFormatter.date(from: toDateStr) else {
            call.reject("Invalid date format")
            return
        }
        
        api.getSteps(identifier: identifier, fromDate: fromDate, toDate: toDate)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { stepsData in
                    let data = stepsData.map { step -> [String: Any] in
                        [
                            "date": dateFormatter.string(from: step.date),
                            "steps": step.steps
                        ]
                    }
                    call.resolve(["data": data])
                },
                onFailure: { error in
                    call.reject("Failed to get steps: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getDistance(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let fromDateStr = call.getString("fromDate"),
              let toDateStr = call.getString("toDate") else {
            call.reject("Missing parameters")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        guard let fromDate = dateFormatter.date(from: fromDateStr),
              let toDate = dateFormatter.date(from: toDateStr) else {
            call.reject("Invalid date format")
            return
        }
        
        api.getDistance(identifier: identifier, fromDate: fromDate, toDate: toDate)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { distanceData in
                    let data = distanceData.map { distance -> [String: Any] in
                        [
                            "date": dateFormatter.string(from: distance.date),
                            "distance": Double(distance.distanceMeters)
                        ]
                    }
                    call.resolve(["data": data])
                },
                onFailure: { error in
                    call.reject("Failed to get distance: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getActiveTime(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let fromDateStr = call.getString("fromDate"),
              let toDateStr = call.getString("toDate") else {
            call.reject("Missing parameters")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        guard let fromDate = dateFormatter.date(from: fromDateStr),
              let toDate = dateFormatter.date(from: toDateStr) else {
            call.reject("Invalid date format")
            return
        }
        
        api.getActiveTime(identifier: identifier, fromDate: fromDate, toDate: toDate)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { activeTimeData in
                    let data = activeTimeData.map { activeTime -> [String: Any] in
                        [
                            "date": dateFormatter.string(from: activeTime.date),
                            "activeTimeSeconds": activeTime.timeNonWear.seconds + activeTime.timeSleep.seconds + activeTime.timeSedentary.seconds + activeTime.timeLightActivity.seconds + activeTime.timeContinuousModerateActivity.seconds + activeTime.timeIntermittentModerateActivity.seconds + activeTime.timeContinuousVigorousActivity.seconds + activeTime.timeIntermittentVigorousActivity.seconds
                        ]
                    }
                    call.resolve(["data": data])
                },
                onFailure: { error in
                    call.reject("Failed to get active time: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func getActivitySampleData(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier"),
              let fromDateStr = call.getString("fromDate"),
              let toDateStr = call.getString("toDate") else {
            call.reject("Missing parameters")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        guard let fromDate = dateFormatter.date(from: fromDateStr),
              let toDate = dateFormatter.date(from: toDateStr) else {
            call.reject("Invalid date format")
            return
        }
        
        api.getActivitySampleData(identifier: identifier, fromDate: fromDate, toDate: toDate)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onSuccess: { activityData in
                    call.resolve(["data": []])
                },
                onFailure: { error in
                    call.reject("Failed to get activity sample data: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func sendInitializationAndStartSyncNotifications(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.sendInitializationAndStartSyncNotifications(identifier: identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve(["success": true])
                },
                onError: { error in
                    call.reject("Failed to send initialization: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    @objc func sendTerminateAndStopSyncNotifications(_ call: CAPPluginCall) {
        guard let identifier = call.getString("identifier") else {
            call.reject("Missing identifier")
            return
        }
        
        api.sendTerminateAndStopSyncNotifications(identifier: identifier)
            .observe(on: MainScheduler.instance)
            .subscribe(
                onCompleted: {
                    call.resolve()
                },
                onError: { error in
                    call.reject("Failed to send termination: \(error)")
                }
            ).disposed(by: disposeBag)
    }
    
    /// `fallback` is used when JS sent no settings at all; leaving it nil preserves the
    /// "no settings" meaning that `startOfflineRecording` relies on.
    private func parseSettings(_ settingsDict: JSObject?,
                               fallback: [PolarSensorSetting.SettingType: UInt32]? = nil) -> PolarSensorSetting? {
        guard let settingsDict = settingsDict,
              let settings = settingsDict["settings"] as? [String: [Int]] else {
            return fallback.flatMap { try? PolarSensorSetting($0) }
        }
        
        var polarSettings: [PolarSensorSetting.SettingType: UInt32] = [:]
        for (key, values) in settings {
            if let settingType = parseSettingType(key), let value = values.first {
                polarSettings[settingType] = UInt32(value)
            }
        }
        
        return try? PolarSensorSetting(polarSettings)
    }
    
    private func parseSettingType(_ key: String) -> PolarSensorSetting.SettingType? {
        switch key.lowercased() {
        case "samplerate": return .sampleRate
        case "resolution": return .resolution
        case "range": return .range
        case "channels": return .channels
        default: return nil
        }
    }
    
    /// The JS `PolarDataType` numbering declared in definitions.ts and used by the Android
    /// implementation: HR=0, ECG=1, ACC=2, PPG=3, PPI=4, GYRO=5, MAGNETOMETER=6, TEMPERATURE=7,
    /// PRESSURE=8. Spelled out deliberately -- `PolarDeviceDataType.allCases` is ordered
    /// ecg, acc, ppg, ppi, gyro, magnetometer, hr, ... so indexing it mapped every code to the
    /// wrong stream (notably code 0 stopped ECG instead of HR, leaving HR running after a stop).
    private static let jsDataTypes: [PolarDeviceDataType] = [
        .hr, .ecg, .acc, .ppg, .ppi, .gyro, .magnetometer, .temperature, .pressure
    ]
    
    private static func dataType(forJsCode code: Int) -> PolarDeviceDataType? {
        jsDataTypes.indices.contains(code) ? jsDataTypes[code] : nil
    }
    
    private static func jsCode(for dataType: PolarDeviceDataType) -> Int? {
        jsDataTypes.firstIndex(of: dataType)
    }
    
    /// `PolarDeviceDataType` has no raw value, so round-trip it through the same
    /// `String(describing:)` spelling this file already uses when serialising entries to JS.
    private static func settingsDict(_ settings: PolarSensorSetting) -> [String: [Int]] {
        var dict: [String: [Int]] = [:]
        for (key, values) in settings.settings {
            dict[String(describing: key)] = values.map { Int($0) }
        }
        return dict
    }
    
    private static func dataType(forJsName name: String) -> PolarDeviceDataType? {
        PolarDeviceDataType.allCases.first { String(describing: $0) == name }
    }
}

extension PolarSdk : PolarBleApiPowerStateObserver {
    public func blePowerOn() {
        NSLog("BLE ON")
        Task { @MainActor in
            isBluetoothOn = true
        }
        notifyListeners("blePowerStateChanged", data: ["enabled": true])
    }
    
    public func blePowerOff() {
        NSLog("BLE OFF")
        Task { @MainActor in
            isBluetoothOn = false
        }
        notifyListeners("blePowerStateChanged", data: ["enabled": false])
    }
}

extension PolarSdk : PolarBleApiObserver {
    public func deviceConnecting(_ polarDeviceInfo: PolarDeviceInfo) {
        NSLog("DEVICE CONNECTING: \(polarDeviceInfo)")
        Task { @MainActor in
            self.deviceConnectionState[polarDeviceInfo.deviceId] = DeviceConnectionState.connecting(polarDeviceInfo.deviceId)
        }
        var data = JSObject()
        data["deviceId"] = polarDeviceInfo.deviceId
        data["address"] = polarDeviceInfo.address.uuidString
        data["rssi"] = polarDeviceInfo.rssi
        data["name"] = polarDeviceInfo.name
        data["isConnectable"] = polarDeviceInfo.connectable
        notifyListeners("deviceConnecting", data: data)
    }
    
    public func deviceConnected(_ polarDeviceInfo: PolarDeviceInfo) {
        NSLog("DEVICE CONNECTED: \(polarDeviceInfo)")
        Task { @MainActor in
            self.deviceConnectionState[polarDeviceInfo.deviceId] = DeviceConnectionState.connected(polarDeviceInfo.deviceId)
        }
        var data = JSObject()
        data["deviceId"] = polarDeviceInfo.deviceId
        data["address"] = polarDeviceInfo.address.uuidString
        data["rssi"] = polarDeviceInfo.rssi
        data["name"] = polarDeviceInfo.name
        data["isConnectable"] = polarDeviceInfo.connectable
        notifyListeners("deviceConnected", data: data)
    }
    
    public func deviceDisconnected(_ polarDeviceInfo: PolarDeviceInfo, pairingError: Bool) {
        NSLog("DISCONNECTED: \(polarDeviceInfo)")
        Task { @MainActor in
            self.deviceConnectionState[polarDeviceInfo.deviceId] = DeviceConnectionState.disconnected(polarDeviceInfo.deviceId)
        }
        var data = JSObject()
        data["deviceId"] = polarDeviceInfo.deviceId
        data["address"] = polarDeviceInfo.address.uuidString
        data["rssi"] = polarDeviceInfo.rssi
        data["name"] = polarDeviceInfo.name
        data["isConnectable"] = polarDeviceInfo.connectable
        notifyListeners("deviceDisconnected", data: data)
    }
}

extension PolarSdk : PolarBleApiDeviceInfoObserver {
    public func disInformationReceivedWithKeysAsStrings(_ identifier: String, key: String, value: String) {
        var data = JSObject()
        data["identifier"] = identifier
        data["uuid"] = key
        data["value"] = value
        notifyListeners("disInformationReceived", data: data)
    }
    
    public func batteryLevelReceived(_ identifier: String, batteryLevel: UInt) {
        NSLog("battery level updated: \(batteryLevel)")
        var data = JSObject()
        data["identifier"] = identifier
        data["level"] = Int(batteryLevel)
        notifyListeners("batteryLevelReceived", data: data)
    }
    
    // Required by PolarBleApiDeviceInfoObserver as of PolarBleSdk 6.x. Only
    // batteryPowerSourcesStateReceived has a default implementation, so this one must be provided.
    public func batteryChargingStatusReceived(_ identifier: String, chargingStatus: BleBasClient.ChargeState) {
        var data = JSObject()
        data["identifier"] = identifier
        data["chargingStatus"] = String(describing: chargingStatus)
        notifyListeners("batteryChargingStatusReceived", data: data)
    }
    
    public func disInformationReceived(_ identifier: String, uuid: CBUUID, value: String) {
        NSLog("dis info: \(uuid.uuidString) value: \(value)")
        var data = JSObject()
        data["identifier"] = identifier
        data["uuid"] = uuid.uuidString
        data["value"] = value
        notifyListeners("disInformationReceived", data: data)
    }
}

extension PolarSdk : PolarBleApiDeviceFeaturesObserver {
    public func bleSdkFeatureReady(_ identifier: String, feature: PolarBleSdk.PolarBleSdkFeature) {
        NSLog("Feature is ready: \(feature)")
        var data = JSObject()
        data["identifier"] = identifier
        data["feature"] = PolarBleSdkFeature.allCases.firstIndex(of: feature)!
        notifyListeners("sdkFeatureReady", data: data)
    }
    
    public func hrFeatureReady(_ identifier: String) {
        NSLog("HR ready")
    }
    
    public func ftpFeatureReady(_ identifier: String) {
        NSLog("FTP ready")
    }
    
    public func streamingFeaturesReady(_ identifier: String, streamingFeatures: Set<PolarDeviceDataType>) {
        for feature in streamingFeatures {
            NSLog("Feature \(feature) is ready.")
        }
    }
}

extension PolarSdk : PolarBleApiLogger {
    public func message(_ str: String) {
        NSLog("Polar SDK log:  \(str)")
    }
}
