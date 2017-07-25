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

const async = require('async');
const b = require('octalbonescript');
const sleep = require('sleep');

// TODO : make pins configurable on the object
// Set these to the physical Beaglebone Black pin numbers to which your SHT1x pins are connected.
const PIN_SCK = 'P9_13';
const PIN_DATA = 'P9_11';
const BYTE_RESET = 0x1E;

// Coefficients per the datasheet
const C1 = -2.0468;
const C2 = 0.0367;
const C3 = -0.0000015955;
const T1 = 0.01;
const T2 = 0.00008;
const D1 = -39.66;
const D2 = 0.01;

// Global value containing the current checksum value
let CRCValue = 0;

let SHT1x = {
    /**
     * Initializes transmissions for the first time.
     */
    init: (callback) => {
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
    reset: (callback) => {
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
            (callback) => {
                SHT1x._sendByte(BYTE_RESET, callback);
            }
        );
        async.series(sequence, callback);
    },

    /**
     * Calls the transmission start sequence.
     */
    _transmissionStart: (callback) => {
        async.series([
            SCKHigh, Wait,
            DataLow, Wait,
            SCKLow, Wait,
            SCKHigh, Wait,
            DataHigh, Wait,
            SCKLow, Wait
        ], (error) => {
            CRCValue = 0;
            callback(error);
        });
    },

    /**
     * Sends a byte to the sensor.
     */
    _sendByte: (value, callback) => {
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

        async.series(sequence, (error) => {
            if (error) {
                callback(error);
                return;
            }
            DataRead((error, dataValue) => {
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
    _readByte: (sendACK, callback) => {
        let value = 0;
        let sequence = [];

        for (let mask = 0x80; mask; mask >>= 1) {
            sequence.push(
                SCKHigh, Wait,
                ((mask, callback) => {
                    DataRead(((mask, error, dataValue) => {
                        if (error) {
                            callback(error);
                            return;
                        }
                        if (dataValue != 0) {
                            value |= mask;
                        }
                        callback();
                    }).bind(undefined, mask));
                }).bind(undefined, mask),
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
        async.series(sequence, (error) => {
            callback(error, value);
        });
    },

    /**
     * Tells the sensor to start a particular type of measurement.
     */
    _startMeasurement: (type, callback) => {
        async.series([
            SHT1x._transmissionStart,
            (callback) => {
                SHT1x._sendByte(type, callback);
            }
        ], callback);
    },

    /**
     * Get a value currently stored in the sensor.
     *
     * @param {function} callback function(error, value)
     */
    _getValue: (callback) => {
        // Wait for measurement to complete (timeout after 250 ms = 210 ms + 15%)
        let continueWaiting = true;
        let delayCount = 62;
        async.whilst(
            () => {
                return continueWaiting;
            },
            (callback) => {
                DataRead((error, dataValue) => {
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
            (error) => {
                if (error) {
                    callback(error);
                    return;
                }
                // A value is available for us
                let composedValue = 0;
                async.series([
                    (callback) => {
                        // Read High Byte
                        SHT1x._readByte(true, (error, dataValue) => {
                            composedValue = dataValue << 8;
                            SHT1x._mutateCRC(dataValue);
                            callback(error);
                        });
                    },
                    (callback) => {
                        // Read Low Byte
                        SHT1x._readByte(true, (error, dataValue) => {
                            composedValue += dataValue;
                            SHT1x._mutateCRC(dataValue);
                            callback(error);
                        });
                    },
                    (callback) => {
                        // Read checksum
                        SHT1x._readByte(false, (error, dataValue) => {
                            if (error) {
                                callback(error);
                            } else if (CRCValue !== mirrorByte(dataValue)) {
                                callback('Checksum does not match');
                            } else {
                                callback();
                            }
                        });
                    }
                ], (error) => {
                    callback(error, composedValue);
                });
            }
        );
    },

    /**
     * Measures and retrieves a single sensor value.
     */
    _getSensorValue: (type, valueCallback) => {
        let rawValue;
        async.series([
            (callback) => {
                SHT1x._startMeasurement(type, callback);
            },
            (callback) => {
                SHT1x._getValue((error, value) => {
                    if (error) {
                        callback(error);
                        return;
                    }
                    rawValue = value;
                    callback();
                });
            }
        ], (error) => {
            valueCallback(error, rawValue);
        });
    },

    /**
     * Measures and retrieves the main sensor values (temperature, relative
     * humidity, and estimated dewpoint) as a handy object.
     *
     * @param {function} valuesCallback function(error, object)
     */
    getSensorValues: (valuesCallback) => {
        let rawTemp, rawHumidity;
        async.series([
            (callback) => {
                SHT1x._getSensorValue(SHT1x.TYPE_TEMPERATURE, (error, value) => {
                    rawTemp = value;
                    callback(error);
                });
            },
            (callback) => {
                SHT1x._getSensorValue(SHT1x.TYPE_HUMIDITY, (error, value) => {
                    rawHumidity = value;
                    callback(error);
                });
            }
        ], (error) => {
            valuesCallback(error, calculateValues(rawTemp, rawHumidity));
        });
    },

    /**
     * Closes the pins that we opened.
     */
    // shutdown: (callback) => {
    //     gpio.close(PIN_SCK);
    //     gpio.close(PIN_DATA);
    //     callback && callback();
    // },

    _mutateCRC: (value) => {
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

const SCKOutput = (callback) => {
    b.pinMode(PIN_SCK, b.OUTPUT, callback);
}

const SCKLow = (callback) => {
    b.digitalWrite(PIN_SCK, b.LOW, callback);
}

const SCKHigh = (callback) => {
    b.digitalWrite(PIN_SCK, b.HIGH, callback);
}

const DataOutput = (callback) => {
    b.pinMode(PIN_DATA, b.OUTPUT, callback);
}

const DataLow = (callback) => {
    b.pinMode(PIN_DATA, b.OUTPUT, callback);
}

const DataHigh = (callback) => {
    b.pinMode(PIN_DATA, b.INPUT, callback);
}

const DataRead = (callback) => {
    b.digitalRead(PIN_DATA, callback);
}

const Wait = (callback) => {
    sleep.usleep(2);
    callback();
}

const LongWait = (callback) => {
    sleep.usleep(20000); // 20 ms
    callback();
}

const calculateValues = (rawTemp, rawHumidity) => {
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

const calculateDewpoint = (temp, humidity) => {
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

const mirrorByte = (value) => {
    let ret = 0;
    for (let ii = 0x80; ii; ii >>= 1) {
        if (value & 0x01) {
            ret |= ii;
        }
        value >>= 1;
    }
    return ret;
}
