require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorPolarSdk'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = package['repository']['url']
  s.author = package['author']
  s.source = { :git => package['repository']['url'], :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target  = '14.0'
  s.dependency 'Capacitor'
  # Pinned exactly: this plugin's Swift is written against 6.8.0's iOS API surface and 6.x minors
  # have added protocol requirements before. Keep in lockstep with android/build.gradle.
  s.dependency 'PolarBleSdk', '6.8.0'
  s.swift_version = '5.1'
end
