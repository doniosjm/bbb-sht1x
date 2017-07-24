"use strict";

/**
 * Beaglebone Black library for SHT1x humidity/temperature sensors. Forked from https://github.com/keito/pi-sht1x and updated to use with Octalbonescript (https://github.com/theoctal/octalbonescript).
 * Author: Jeff Donios (jeff@donios.com)
 * Date: July 2017
 * License: CC BY-SA v3.0 - http://creativecommons.org/licenses/by-sa/3.0/
 *
 * Forked from:
 * Raspberry Pi SHT1x Communication Library for Node.js
 * Author:  Keito Uchiyama (keito.me)
 * Date:    October 2013
 * License: CC BY-SA v3.0 - http://creativecommons.org/licenses/by-sa/3.0/
 *
 * This work is based on the C library by John Burns:
 * Raspberry Pi SHT1x communication library.
 * By:      John Burns (www.john.geek.nz)
 * Date:    01 November 2012
 * License: CC BY-SA v3.0 - http://creativecommons.org/licenses/by-sa/3.0/
 */

let async = require('async');
let b = require('octalbonescript');
let sleep = require('sleep');

// TODO : make pins configurable on the object
// Set these to the physical Beaglebone Black pin numbers to which your SHT1x pins are connected.
let PIN_SCK = 'P9_13';
let PIN_DATA = 'P9_11';
BYTE_RESET = 0x1E;

// Coefficients per the datasheet
let C1 = -2.0468;
let C2 = 0.0367;
let C3 = -0.0000015955;
let T1 = 0.01;
let T2 = 0.00008;
let D1 = -39.66;
let D2 = 0.01;

// Global value containing the current checksum value
let CRCValue = 0;

let SHT1x = {
    /**
     * Initializes transmissions for the first time.
     */
    init: function(callback) {
        async.series([
            LongWait,
            SCKOutput,
            SCKLow,
            DataOutput,
            DataLow
        ], callback);
    },

    /**
     * Resets transmissions with the sensor.
     */
    reset: function(callback) {
        let sequence = [
            DataHigh, Wait
        ];
        for (let ii = 0; ii < 9; ii++) {
            sequence.push(
                SCKHigh, Wait,
                SCKLow, Wait
            );
        }
        sequence.push(
            SHT1x._transmissionStart,
            function(callback) {
                SHT1x._sendByte(BYTE_RESET, callback);
            }
        );
        async.series(sequence, callback);
    },

    /**
     * Calls the transmission start sequence.
     */
    _transmissionStart: function(callback) {
        async.series([
            SCKHigh, Wait,
            DataLow, Wait,
            SCKLow, Wait,
            SCKHigh, Wait,
            DataHigh, Wait,
            SCKLow, Wait
        ], function(error) {
            CRCValue = 0;
            callback(error);
        });
    },

    /**
     * Sends a byte to the sensor.
     */
    _sendByte: function(value, callback) {
        let sequence = [];
        for (let mask = 0x80; mask; mask >>= 1) {
            sequence.push(
                SCKLow, Wait,
                (value & mask) ? DataHigh : DataLow, Wait,
                SCKHigh, Wait
            );
        }
        sequence.push(
            SCKLow, Wait,

            // Release DATA line
            DataHigh, Wait,
            SCKHigh, Wait
        );

        async.series(sequence, function(error) {
            if (error) {
                callback(error);
                return;
            }
            DataRead(function(error, dataValue) {
                if (error) {
                    callback(error);
                    return;
                }
                if (dataValue) {
                    callback("Send byte not acked");
                    return;
                };
                SHT1x._mutateCRC(value);

                async.series([SCKLow, Wait], callback);
            });
        });
    },

    /**
     * Reads a byte from the sensor.
     *
     * @param {bool} sendACK Whether to send an ACK
     * @param {function} callback function(error, value)
     */
    _readByte: function(sendACK, callback) {
        let value = 0;
        let sequence = [];

        for (let mask = 0x80; mask; mask >>= 1) {
            sequence.push(
                SCKHigh, Wait,
                function(mask, callback) {
                    DataRead(function(mask, error, dataValue) {
                        if (error) {
                            callback(error);
                            return;
                        }
                        if (dataValue != 0) {
                            value |= mask;
                        }
                        callback();
                    }.bind(undefined, mask));
                }.bind(undefined, mask),
                SCKLow, Wait // Tell sensor to give us more data
            );
        }

        if (sendACK) {
            sequence.push(DataLow, Wait);
        }
        sequence.push(
            SCKHigh, Wait,
            SCKLow, Wait
        );
        if (sendACK) {
            sequence.push(DataHigh, Wait);
        }
        async.series(sequence, function(error) {
            callback(error, value);
        });
    },

    /**
     * Tells the sensor to start a particular type of measurement.
     */
    _startMeasurement: function(type, callback) {
        async.series([
            SHT1x._transmissionStart,
            function(callback) {
                SHT1x._sendByte(type, callback);
            }
        ], callback);
    },

    /**
     * Get a value currently stored in the sensor.
     *
     * @param {function} callback function(error, value)
     */
    _getValue: function(callback) {
        // Wait for measurement to complete (timeout after 250 ms = 210 ms + 15%)
        let continueWaiting = true;
        let delayCount = 62;
        async.whilst(
            function() {
                return continueWaiting;
            },
            function(callback) {
                DataRead(function(error, dataValue) {
                    if (error) {
                        callback(error);
                        return;
                    }
                    // DATA pin will get low once we have data
                    if (!dataValue) {
                        continueWaiting = false;
                    }

                    delayCount = delayCount - 1;
                    if (delayCount === 0) {
                        continueWaiting = false;
                        callback("Timed out waiting for data");
                    }

                    // Wait
                    sleep.usleep(5000);
                    callback();
                });
            },
            function(error) {
                if (error) {
                    callback(error);
                    return;
                }
                // A value is available for us
                let composedValue = 0;
                async.series([
                    function(callback) {
                        // Read High Byte
                        SHT1x._readByte(true, function(error, dataValue) {
                            composedValue = dataValue << 8;
                            SHT1x._mutateCRC(dataValue);
                            callback(error);
                        });
                    },
                    function(callback) {
                        // Read Low Byte
                        SHT1x._readByte(true, function(error, dataValue) {
                            composedValue += dataValue;
                            SHT1x._mutateCRC(dataValue);
                            callback(error);
                        });
                    },
                    function(callback) {
                        // Read checksum
                        SHT1x._readByte(false, function(error, dataValue) {
                            if (error) {
                                callback(error);
                            } else if (CRCValue !== mirrorByte(dataValue)) {
                                callback('Checksum does not match');
                            } else {
                                callback();
                            }
                        });
                    }
                ], function(error) {
                    callback(error, composedValue);
                });
            }
        );
    },

    /**
     * Measures and retrieves a single sensor value.
     */
    _getSensorValue: function(type, valueCallback) {
        let rawValue;
        async.series([
            function(callback) {
                SHT1x._startMeasurement(type, callback);
            },
            function(callback) {
                SHT1x._getValue(function(error, value) {
                    if (error) {
                        callback(error);
                        return;
                    }
                    rawValue = value;
                    callback();
                });
            }
        ], function(error) {
            valueCallback(error, rawValue);
        });
    },

    /**
     * Measures and retrieves the main sensor values (temperature, relative
     * humidity, and estimated dewpoint) as a handy object.
     *
     * @param {function} valuesCallback function(error, object)
     */
    getSensorValues: function(valuesCallback) {
        let rawTemp, rawHumidity;
        async.series([
            function(callback) {
                SHT1x._getSensorValue(SHT1x.TYPE_TEMPERATURE, function(error, value) {
                    rawTemp = value;
                    callback(error);
                });
            },
            function(callback) {
                SHT1x._getSensorValue(SHT1x.TYPE_HUMIDITY, function(error, value) {
                    rawHumidity = value;
                    callback(error);
                });
            }
        ], function(error) {
            valuesCallback(error, calculateValues(rawTemp, rawHumidity));
        });
    },

    /**
     * Closes the pins that we opened.
     */
    // shutdown: function(callback) {
    //     gpio.close(PIN_SCK);
    //     gpio.close(PIN_DATA);
    //     callback && callback();
    // },

    _mutateCRC: function(value) {
        for (let ii = 8; ii; ii--) {
            if ((CRCValue ^ value) & 0x80) {
                CRCValue <<= 1;
                CRCValue ^= 0x31;
            } else {
                CRCValue <<= 1;
            }
            value <<= 1;
        }
        CRCValue &= 0xFF;
    }
}

SHT1x.TYPE_TEMPERATURE = 0x03;
SHT1x.TYPE_HUMIDITY = 0x05;

module.exports = SHT1x;

function SCKOutput(callback) {
    b.pinMode(PIN_SCK, b.OUTPUT, callback);
}

function SCKLow(callback) {
    b.digitalWrite(PIN_SCK, b.LOW, callback);
}

function SCKHigh(callback) {
    b.digitalWrite(PIN_SCK, b.HIGH, callback);
}

function DataOutput(callback) {
    b.pinMode(PIN_DATA, b.OUTPUT, callback);
}

function DataLow(callback) {
    b.pinMode(PIN_DATA, b.OUTPUT, callback);
}

function DataHigh(callback) {
    b.pinMode(PIN_DATA, b.INPUT, callback);
}

function DataRead(callback) {
    b.digitalRead(PIN_DATA, callback);
}

function Wait(callback) {
    sleep.usleep(2);
    callback();
}

function LongWait(callback) {
    sleep.usleep(20000); // 20 ms
    callback();
}

function calculateValues(rawTemp, rawHumidity) {
    // Temperature in Celsius
    let trueTemp = D1 + (D2 * rawTemp);
    // Humidity
    let rhLinear = C1 + (C2 * rawHumidity) + (C3 * rawHumidity * rawHumidity);
    // Humidity compensated for temperature
    let trueHumidity = (trueTemp - 25) * (T1 + (T2 * rawHumidity)) + rhLinear;
    trueHumidity = Math.max(Math.min(trueHumidity, 100), 0.1);
    return {
        temperature: trueTemp,
        humidity: trueHumidity,
        dewpoint: calculateDewpoint(trueTemp, trueHumidity)
    };
}

function calculateDewpoint(temp, humidity) {
    let Tn = 243.12;
    let m = 17.62;
    if (temp < 0) {
        Tn = 272.62;
        m = 22.46;
    }
    let lnRH = Math.log(humidity / 100);
    let mTTnT = (m * temp) / (Tn + temp);
    return Tn * ((lnRH + mTTnT) / (m - lnRH - mTTnT));
}

function mirrorByte(value) {
    let ret = 0;
    for (let ii = 0x80; ii; ii >>= 1) {
        if (value & 0x01) {
            ret |= ii;
        }
        value >>= 1;
    }
    return ret;
}
