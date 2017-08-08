beaglebone-black-sht1x
========

Node.js library for the SHT1x (SHT10, SHT11, SHT15) family of humidity/temperature sensors for Beaglebone Black using Octablbonescript. Forked from [keito's Raspberry Pi library](https://github.com/keito/pi-sht1x).

The sensor is sold as a soil temperature/moisture sensor at many popular electronics outlets.

This library assumes that your sensor pins are hooked up as follows:

| SHT1x Pin | Connected to
| --------- | -------------------------
| GND       | Ground
| DATA      | 5V Power via 10k pullup resistor AND P9_11 (configurable)
| SCK       | P9_13 (configurable)
| VCC       | 5V Power

If your `DATA` and `SCK` pins are hooked up to different pins, you can modify that atop `SHT1x.js`. Note that the `octablbonescript` library uses header pin numbers to refer to the GPIO ports, and not the GPIO numbers. For more information, see https://github.com/theoctal/octalbonescript/wiki/PinMode.

Simple example:

```JavaScript
var async = require('async');
var SHT1x = require('beaglebone-black-sht1x');

async.series([
  SHT1x.init(sck, data, callback),
  SHT1x.reset,
  function(callback) {
    SHT1x.getSensorValues(function(error, values) {
      console.log(values);
      callback(error);
    });
  }
], function(error) {
  SHT1x.shutdown();
  if (error) {
    console.error(error);
  }
});
```

The example above, when run, will output the current temperature, relative humidity, and dewpoint:

```
{ temperature: 21.210000000000008,
  humidity: 50.90574136050001,
  dewpoint: 10.637735199001309 }
```
