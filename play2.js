let midi = require('midi');
let data = require('lemandataexplorer');
let axios = require('axios');
let myArgs = process.argv.slice(2);
let fs = require('graceful-fs');
let abletonApi = require('abletonapi');
let TWEEN = require('tween.js');
let Moment = require('moment');

class Player {
    constructor() {
        //DataExplorer library for offline test
        this.dataExplorer = new data();

        //MIDI setup
        this.output = new midi.output();
        this.output.openVirtualPort("Test Output");
        this.input = new midi.input();
        this.input.openVirtualPort("Test input");

        //Ableton Data
        this.scenes = [ ]; //Contains all Ableton Scenes
        this.maxTracks = 0; //Max numbers of tracks registered
        this.tracksToStartFrom = [ ]; //List of track ID´s of tracks to start from
        this.speaks = [ ]; //List speak tracks
        this.speakTrack = 17;
        this.speakerCars = {1: 'Porsche-1', 13: 'Car-13', 24: 'Car-24', 31: 'Car-31', 35: 'Car-35', 38: 'Car-38', 2: 'Porsche-2'};

        //Application data
        this.mainInterval = null; //Main loop
        this.currentData = null; //Object containing current loaded data
        this.oldCarData = { }; //Object containing data of car positions in last update
        this.firstTime = true; //Tells if we area rendering the first loop
        this.runningFilterChange = false;
        this.runningPitFilterChange = false;
        this.runningOldPitFilterChange = false;
        this.runningTempoChange = false;
        this.lastTrackTimes = -1;
        this.autotimes = Math.floor(Math.random() * 6) + 1;


        //File data
        this.saveFile = './playdata2.json'; //File to save playdata to
        this.chkValues = { }; //Object containing data on checked values
        this.playData = { //Object containing current loaded playdata

        };

        //MIDI data
        this.midiWorking = false; //Check if MIDI is currently in use

        //Enviroment data
        this.live = true; //Set to true if track is running live
        this.config = {};
        this.configModDate = null;
        this.configUpdate = false;
    }

    /**
     * Main Loop Starter
     */
    run() {
        setInterval(() => {
            TWEEN.update();
        }, 100);

        this.parseAbletonData().then(() => {
            if(fs.existsSync(this.saveFile)) {
                console.log('Playing from ' + this.saveFile);
                let fileData = JSON.parse(fs.readFileSync(this.saveFile));
                this.playData = fileData.playData;
                this.chkValues = fileData.chkValues;
            }

            if(this.live === true) {
                this.mainInterval = setInterval(() => {
                    axios.get('http://192.168.1.34:3000').then((resp) => {
                        this.currentData = resp.data;
                        this.render();

                        if(this.firstTime) {
                            this.onMidiNote();
                            this.firstTime = false;
                        }
                    }).catch((err) => {
                        console.log('No data - trying again',err);
                    })
                }, 1000);
            } else {
                let data = null;
                let currentSec =  0;
                setInterval(() => {
                    data = this.dataExplorer.getData(currentSec);
                    this.setPlayData('currentSec', currentSec + 1);
                    currentSec += 1;
                }, 1);

                this.mainInterval = setInterval(() => {
                    this.currentData = data;
                    this.render();

                    if(this.firstTime) {
                        this.onMidiNote();
                        this.firstTime = false;
                    }
                }, 1000);
            }

            //Setup MIDI listener
            this.input.on('message', () => { this.onMidiNote() });
        });
    }

    /**
     * Reads static data from ableton
     * @returns {Promise.<TResult>}
     */
    parseAbletonData() {
        console.log('Parsing ableton data...');
        //abletonApi.getParametersForDevice('master_track', 0).then((data) => {
        //   console.log('paramereter data', data);
        //});

        return Promise.all([
            abletonApi.getScenes().then((scenes) => {
                console.log('Ableton data parsed!');
                this.scenes = scenes.filter((scene) => {
                    return (scene.name.match(/^[0-9][0-9]/gi));
                });

                this.maxTracks = this.scenes.length;

                let lastName = null;
                this.tracksToStartFrom = this.scenes.filter((track) => {
                    let check = (track.name != lastName);
                    lastName = track.name;
                    return check;
                }).map((track) => {
                    return track.id
                });
            }),
            abletonApi.getClipsForTrack(this.speakTrack).then((list) => {
                for(let i in list) {
                    let clip = list[i];
                    this.speaks.push({
                       id: clip.id,
                       name: clip.clip.name
                    });
                }
                console.log('Speaker clips', this.speaks);
            })
        ]);
    }

    onMidiNote() {
        if(this.midiWorking) {
            return;
        }

        this.midiWorking = true;
        setTimeout(() => {
            this.midiWorking = false;
        }, 1000);

        console.log('I´VE RECIVE MIDI!!!');
        this.setDrums();
        this.setCurrentPlayingTrack(); //Sets current playing track
    }

    /**
     * Sets current playing track
     */
    setCurrentPlayingTrack() {
        if(this.getPlayData('flag') === 4 && !this.getPlayData('lastTrack')) {
            console.log('Playing last track!');
            this.setPlayData('lastTrack', true);
            this.setPlayData('musicLab', this.config.endingMusicTrack - 1);
        }

        if(this.firstTime && this.getPlayData('musicLab')) {
            abletonApi.playScene(this.getPlayData('musicLab'));
        }

        if(!this.getPlayData('lastTrack') && !this.getPlayData('safetyCar') && !this.config.autoPlay) {
            if(this.checkPlayDataChange('currentLab', 'musicLabChk')) {
                abletonApi.playScene(this.nextTrack());
            }
        } else {
            console.log('--- AUTOPLAY MODE ---');
            this.autoPlay();
        }
    }

    /**
     * Automatic playback
     */
    autoPlay() {
        console.log('Autotimes', {'autotime': this.autotimes, 'lastTrackTime': this.lastTrackTimes});
        if(this.lastTrackTimes >= this.autotimes || this.lastTrackTimes < 0) {
            this.lastTrackTimes = 0;
            abletonApi.playScene(this.nextTrack());
        } else {
            this.lastTrackTimes += 1;
        }
    }

    /**
     * Advance musicLab by 1 and returns it
     * @returns {*}
     */
    nextTrack() {
        let currentTrack = this.getPlayData('musicLab', -1);
        let nextTrack = currentTrack + 1;
        if(((nextTrack > this.maxTracks) || this.config.trackOverflow) && !this.getPlayData('maxTracksOverflow')) {
            console.log('Track overflow enabled!');
            this.setPlayData('maxTracksOverflow', true);
        }

        if(this.getPlayData('maxTracksOverflow') && !this.getPlayData('lastTrack')) {
            for(let i in this.tracksToStartFrom) {
                if((this.tracksToStartFrom[i] - 1) === currentTrack) {
                    nextTrack = this.tracksToStartFrom[Math.floor(Math.random() * (this.tracksToStartFrom.length - 1))];
                }
            }
        }

        console.log('Playing track', nextTrack);
        if(this.getPlayData('lastTrack') && nextTrack > this.config.stopMusicTrack) {
            return currentTrack;
        }

        this.setPlayData('musicLab', nextTrack);
        this.autotimes = Math.floor(Math.random() * this.config.autoTimes) + 1;
        return nextTrack;
    }

    /**
     * Main loop for taking actions on data
     */
    render() {
        this.readConfig();
        if(this.configUpdate) {
            this.onMidiNote();
        }
        this.readCars();
        this.readTrackData();
        this.readFlagStatus();

        this.setTrackBpm();
        this.setMasterFilter();
        this.setFilters();
        this.playSpeaks();
        this.updateFile();
        this.configUpdate = false;
    }

    setFilters() {
        let oldPitStatus = this.checkPlayDataChange('pitStatus', 'pitStatusFilters');
        if(oldPitStatus !== false) {
            if(!this.runningPitFilterChange) {
                this.runningFilterChange = true;
                let pitters = Math.round(this.getPlayData('pitStatus') * 20);
                oldPitStatus = Math.round(oldPitStatus * 20);

                new TWEEN.Tween({x:oldPitStatus}).to({x: pitters}).onUpdate(function() {
                    console.log('Changing pitters', this.x);
                    abletonApi.setParameterForDevice(8, 3, 1, this.x.toFixed(2));
                    abletonApi.setParameterForDevice(11, 0, 1, this.x.toFixed(2));
                    abletonApi.setParameterForDevice(13, 0, 1, this.x.toFixed(2));
                }).onComplete(() => {
                    this.runningFilterChange = false;
                }).start();
            }
        }

        let oldPitOutStatus = this.checkPlayDataChange('pitOut', 'pitOutStatusFilter');
        if(oldPitOutStatus !== false) {
            if(!this.runningOldPitFilterChange) {
                this.runningOldPitFilterChange = true;
                let pitOuts = Math.round(this.getPlayData('pitOut') * 20);
                oldPitOutStatus = Math.round(oldPitOutStatus * 20);

                new TWEEN.Tween({x:oldPitOutStatus}).to({x: pitOuts}).onUpdate(function() {
                    console.log('Changing PitOut', this.x);
                    abletonApi.setParameterForDevice(9, 2, 1, this.x.toFixed(2));
                    abletonApi.setParameterForDevice(12, 0, 1, this.x.toFixed(2));
                }).onComplete(() => {
                    this.runningOldPitFilterChange = false;
                }).start();
            }
        }
    }

    playSpeaks() {
        if(this.checkPlayDataChange('safetyCar', 'safetyCarPlaySpeak') && this.getPlayData('safetyCar')) {
            console.log('Safety Car');
            this.playSpeak('Safety-car');
        }

        if(this.checkPlayDataChange('pitDriver', 'pitDriverPlaySpeaks') && !this.firstTime) {
            let pitDriver = this.getPlayData('pitDriver');
            pitDriver = this.currentData.cars[pitDriver];
            console.log('Pit driver selected', pitDriver);
            let sound = this.getSoundNameByCar(pitDriver);
            if(sound) {
                console.log('Playing sound - for pit', sound);
                this.playSpeak(sound);
                setTimeout(() => {
                    this.playSpeak('in-pit');
                }, 4000);
            }
        }

        if(this.checkPlayDataChange('firstPlace', 'firstPlacePlaySpeaks') && !this.firstTime) {
            let firstPlace = this.currentData.cars.filter((car) => {
                return (car.category === 'LMP2');
            })[0];

            console.log('New lead position', firstPlace);
            let sound = this.getSoundNameByCar(firstPlace);
            if(sound) {
                console.log('Driver takes the lead', sound);
                this.playSpeak(sound);
                setTimeout(() => {
                    this.playSpeak('takes-the-lead');
                }, 4000);
            }
        }

        if(this.checkPlayDataChange('firstDriverChange', 'playDroverChangeSpeakChk')) {
            let driverName = this.getPlayData('firstDriverChange');
            driverName = driverName.split(' ')[0].toLowerCase();
            let nameTracks = ['Porsche-1-andre-lotterer-driving', 'Porsche-1-neel-jani-driving', 'Porsche-1-nick-tandy-driving'];
            let track = nameTracks.filter((item) => {
               return (item.indexOf(driverName) !== -1);
            });

            if(track[0]) {
                this.playSpeak(track[0]);
            }
        }

        if(this.checkPlayDataChange('hourLeft', 'hourLeftSpeakCheck') && !this.firstTime) {
            let hour = this.getPlayData('hourLeft');
            this.playSpeak('hours-' + hour);
        }

        if(this.checkPlayDataChange('minutesLeft', 'minuteLeftSpeakCheck') && !this.firstTime) {
            let min = this.getPlayData('minutesLeft');
            this.playSpeak('min-' + min);
        }
    }

    getSoundNameByCar(car) {
        return this.speakerCars[car.number];
    }

    setTrackBpm() {
        let oldVal = this.checkPlayDataChange('firstCarLabTime', 'setTrackBpm', true);
        if(oldVal !== false || this.configUpdate) {
            if(!this.runningTempoChange) {
                this.runningTempoChange = true;

                let speedDivider = this.config.bpmDivider;
                let newVal = Math.round(this.getPlayData('firstCarLabTime') / speedDivider);
                abletonApi.getTempo().then((currentVal) => {
                    if(newVal < this.config.bpmMinMax[0]) {
                        newVal = this.config.bpmMinMax[0];
                    } else if(newVal > this.config.bpmMinMax[1]) {
                        newVal = this.config.bpmMinMax[1];
                    }

                    console.log('Changing BPM', {from: currentVal, to: newVal});
                    new TWEEN.Tween({x: currentVal})
                        .to({x: newVal}, 30000)
                        .onUpdate(function() {
                            console.log('Changing bpm', this.x.toFixed(2));
                            abletonApi.setTempo(this.x.toFixed(2));
                        })
                        .onComplete(() => {
                            this.runningTempoChange = false;
                        })
                        .start();
                });
            }
        }
    }

    setDrums() {
        if(this.checkPlayDataChange('windDirection', 'setDrumsWind') || this.configUpdate) {
            let raw = this.getPlayData('windDirection');
            let percent = raw/360;
            let knop = Math.round(this.config.snareMaxValue*percent);
            console.log('Setting snare to', {raw, percent, knop});
            abletonApi.setParameterForDevice(3, 0, 1, knop);
        }

        if(this.checkPlayDataChange('windSpeed', 'setDrumsWindSpeed') || this.configUpdate) {
            let raw = this.getPlayData('windSpeed');
            let percent = this.getPlayData('windSpeed')/this.config.kickWindSpeedDivider;
            let knop = Math.round(this.config.kickMaxValue*percent);
            console.log('Setting kick to', {raw, percent, knop});
            abletonApi.setParameterForDevice(1, 0, 1, knop);
        }
    }

    setMasterFilter() {
        let oldVal = this.checkPlayDataChange('numberOfPlaceChanges', 'setMasterFilterNumberOfDriverChanges', true);
        if(oldVal !== false) {
            let oldPercent = oldVal/this.config.filterDriverChangeivision;
            let oldKnop = Math.round(this.config.masterFilterMaxVal*oldPercent);

            let driverchanges = this.getPlayData('numberOfPlaceChanges');
            let percent = driverchanges/this.config.filterDriverChangeivision;
            let knop = Math.round(this.config.masterFilterMaxVal*percent);

            console.log('Changing filter using driverchanges', {driverchanges, percent, knop});
            if(!this.runningFilterChange) {
                this.runningFilterChange = true;
                let t1 = Math.floor(Math.random() * 30000) + 10000;
                let t2 = Math.floor(Math.random() * 30000) + 10000;

                new TWEEN.Tween({x: oldKnop})
                    .to({x: knop}, t1)
                    .onUpdate(function() {
                        console.log('Changing master filter', this.x.toFixed(2));
                        abletonApi.setParameterForDevice('master_track', 0, 5, this.x.toFixed(2));
                    })
                    .onComplete(() => {
                        new TWEEN.Tween({x: knop})
                            .to({x: 0}, t2)
                            .onUpdate(function() {
                                console.log('Changing master filter', this.x.toFixed(2));
                                abletonApi.setParameterForDevice('master_track', 0, 5, this.x.toFixed(2));
                            }).onComplete(() => {
                                this.runningFilterChange = false;
                            }).start();
                    })
                    .start();
            } else {
                console.log('Already running filter change!');
            }
        }
    }

    /**
     * Reads flag status
     */
    readFlagStatus() {
        this.setPlayData('flag', this.currentData.track.flag);
        if(this.checkPlayDataChange('flag', 'flagChk') && !this.getPlayData('lastTrack')) {
            switch(this.getPlayData('flag')) {
                case 1:
                    console.log('Track off car on track!');
                    break;
                case 2:
                    this.playSpeak('green-flag');
                    console.log('Green flag');
                    break;
                case 3:
                    console.log('Red flag');
                    break;
                case 4:
                    console.log('Chk flag');
                    break;
                case 5:
                    this.playSpeak('yellow-flag');
                    console.log('Yellow flag!');
                    break;
                case 6:
                    this.playSpeak('yellow-flag');
                    console.log('Full Yellow flag!');
                    break;
            }
        }
    }

    /**
     * Plays a speak by name
     * @param name
     */
    playSpeak(name) {
        let speakObj = this.speaks.filter((speakItem) => {
            return (speakItem.name === name)
        });

        if(typeof speakObj[0] !== 'undefined') {
            abletonApi.playClip(this.speakTrack, speakObj[0].id);
        }
    }

    readTrackData() {
        let weather = this.currentData.track.weather;
        this.setPlayData('windDirection', weather.windDirection);
        this.setPlayData('windSpeed', weather.windSpeed);
        this.setPlayData('airTemp', weather.airTemp);
        this.setPlayData('roadTemp', weather.roadTemp);
        this.setPlayData('airPreassure', weather.airPreassure);
        this.setPlayData('safetyCar', this.currentData.track.safetyCar);
        this.setPlayData('hourLeft', Moment.unix(this.currentData.track.remainingTimeInSeconds).hours());
        if(this.getPlayData('hourLeft') <= 0) {
            this.setPlayData('minutesLeft', Moment.unix(this.currentData.track.remainingTimeInSeconds).minutes());
        }
    }

    /**
     * Reads current car status
     */
    readCars() {
        let cars = this.currentData.cars;
        let accLabs = 0;
        let numberOfCars = cars.length;
        let pits = 0;
        let pitOut = 0;
        let numberOfCarChanges = 0;
        let numberOfDriverChanges = 0;
        let numberOfWetTires = 0;
        let running = 0;
        let averageSpeed = 0;

        for(let i in cars) {
            accLabs += cars[i].laps;
            averageSpeed += cars[i].averageSpeed;

            if(cars[i].driverStatus == 4) {
                if(typeof this.speakerCars[cars[i].number] !== 'undefined') {
                    this.setPlayData('pitDriver', i);
                }
                pits += 1;
            }

            if(cars[i].driverStatus == 3) {
                pitOut += 1;
            }

            if(cars[i].driverStatus == 2) {
                running += 1;
            }

            if(cars[i].tires == 'W') {
                numberOfWetTires += 1;
            }

            if(this.oldCarData[i]) {
                if(cars[i].number !== this.oldCarData[i].number) {
                    numberOfCarChanges += 1;
                }

                if(cars[i].driver !== this.oldCarData[i].driver) {
                    if(this.speakerCars[cars[i].number]) {
                        this.setPlayData('driverChange', cars[i].number);
                    }
                }
            }

        }


        this.setPlayData('running', Math.round(127 * (running/numberOfCars)) + 1);
        this.setPlayData('pitStatus', pits);
        this.setPlayData('pitOut', pitOut);
        this.setPlayData('numberOfPlaceChanges', Math.round(127 * (numberOfCarChanges*10/numberOfCars)) + 1);
        this.setPlayData('numberOfDriverChanges', Math.round(127 * (numberOfDriverChanges*10/numberOfCars)) + 1);
        this.setPlayData('numberOfWetTires', Math.round(127 * (numberOfWetTires*3/numberOfCars)) + 1);
        this.setPlayData('currentLab', Math.abs(accLabs/numberOfCars).toFixed(this.config.currentLabDecimals));
        this.setPlayData('firstDriverChange', cars[0].pilot.firstName);

        if(averageSpeed <= 0) {
            averageSpeed = 200;
        } else {
            averageSpeed = Math.abs(averageSpeed/numberOfCars).toFixed(2);
        }

        this.setPlayData('averageSpeed', averageSpeed);
        this.setPlayData('firstCarLabTime', cars[0].lastTimeInMiliseconds);
        this.setPlayData('firstPlace', cars.filter((car) => {
            return (car.category === 'LMP2');
        })[0].number);
        this.oldCarData = cars;
    };

    /**
     * Sets playdata for a given key
     * @param key
     * @param value
     */
    setPlayData(key, value) {
        this.playData[key] = value;
    }

    /**
     * Returns both new and old playdata for a given key
     * @param key
     * @param old
     * @returns {*}
     */
    getPlayData(key, defaultVal) {
        if(typeof this.playData[key] !== 'undefined') {
            return this.playData[key];
        }

        return (typeof defaultVal !== 'undefined') ? defaultVal : null;
    }

    /**
     * Checks if playdata for a given key has changed
     * @param key
     * @returns {boolean}
     */
    checkPlayDataChange(key, checkId, returnOld) {
        if(!checkId) {
            throw new Error('Checkid should be defined!');
        }

        let currentValue = this.getPlayData(key);
        if(typeof this.chkValues[checkId] !== 'undefined') {
            if(this.chkValues[checkId] !== currentValue) {
                console.log('Updated chackvalue', {
                    checkId: checkId,
                    currentValue: currentValue,
                    oldValue: this.chkValues[checkId]
                });
                let old = this.chkValues[checkId];
                this.chkValues[checkId] = currentValue;
                return (returnOld) ? old : true;
            }

            return false;
        } else if(currentValue !== null) {
            console.log('Creating check value', {
                checkId: checkId,
                currentValue: currentValue,
            });
            this.chkValues[checkId] = currentValue;
            return  (returnOld) ? currentValue : true;
        }

        return false;
    }

    /**
     * Saves current play status data to file
     */
    updateFile() {
        if(!this.spooling) {
            let saveObject = {
              playData: this.playData,
              chkValues: this.chkValues
            };
            fs.writeFileSync(this.saveFile, JSON.stringify(saveObject));
        }
    }

    readConfig() {
        let settingFile = 'settings.json';
        if(fs.existsSync(settingFile)) {
            let fileData = fs.statSync(settingFile);
            if(fileData.mtime.getTime() !== this.configModDate) {
                console.log('Config file has been updated!');
                this.configModDate = fileData.mtime.getTime();
                this.config = JSON.parse(fs.readFileSync(settingFile));
                this.configUpdate = true;
            }
        }
    }
}

let player = new Player();
player.run();