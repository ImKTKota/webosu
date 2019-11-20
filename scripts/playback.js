/*
*   object layering:
*       [0,1) background / storyboard
*       [2,3) hit score, bottom to top
*       [4,5) hit objects, top to bottom
*       [5,6) follow circle & slider ball, one visible instance at a time (add blend)
*       [6,7) approach circle, bottom to top
*       assuming number of possible hits doesn't exceed 9998
*/
define(["osu", "skin", "hash", "curves/LinearBezier", "curves/CircumscribedCircle", "playerActions", "SliderMesh"],
function(Osu, Skin, Hash, LinearBezier, CircumscribedCircle, setPlayerActions, SliderMesh) {
    function Playback(game, osu, track) {
        const SLIDER_LINEAR = "L";
        const SLIDER_CATMULL = "C";
        const SLIDER_BEZIER = "B";
        const SLIDER_PERFECT_CURVE = "P";
        var self = this;
        window.playback = this;
        self.game = game;
        self.osu = osu;
        self.track = track;
        self.background = null;
        self.backgroundOverlay = null;
        self.ready = true;
        self.started = false;
        self.upcomingHits = [];
        self.hits = self.track.hitObjects.slice(0); // creating a copy of hitobjects
        self.offset = 0;
        self.currentHitIndex = 0; // index for all hit objects
        self.autoplay = false;
        self.approachScale = 3;
        var scoreCharWidth = 35;
        var scoreCharHeight = 45;

        var gfx = {}; // game field area
        var calcSize = function() {
            gfx.width = game.window.innerWidth;
            gfx.height = game.window.innerHeight;
            if (gfx.width / 512 > gfx.height / 384)
                gfx.width = gfx.height / 384 * 512;
            else
                gfx.height = gfx.width / 512 * 384;
            gfx.width *= 0.8;
            gfx.height *= 0.8;
            gfx.xoffset = (game.window.innerWidth - gfx.width) / 2;
            gfx.yoffset = (game.window.innerHeight - gfx.height) / 2;
            console.log("gfx: ", gfx)
            // deal with difficulties
            self.circleRadius = (109 - 9 * track.difficulty.CircleSize)/2; // unit: osu! pixel
            self.circleRadiusPixel = self.circleRadius * gfx.width / 512;
            self.hitSpriteScale = self.circleRadiusPixel / 60;
        };
        calcSize();
        self.game.window.onresize = function() {
            self.pause();
            calcSize();
            // regenerate objects
        }

        // deal with difficulties
        let OD = track.difficulty.OverallDifficulty;
        self.MehTime = 200 - 10 * OD;
        self.GoodTime = 140 - 8 * OD;
        self.GreatTime = 80 - 6 * OD;
        let AR = track.difficulty.ApproachRate;
        self.approachTime = AR<5? 1800-120*AR: 1950-150*AR; // time of sliders/hitcircles and approach circles approaching
        self.objectFadeInTime = Math.min(350, self.approachTime); // time of sliders/hitcircles fading in, at beginning of approaching
        self.approachFadeInTime = self.approachTime; // time of approach circles fading in, at beginning of approaching
        self.sliderFadeOutTime = 300; // time of slidebody fading out
        self.circleFadeOutTime = 150;
        self.scoreFadeOutTime = 600;
        self.followZoomInTime = 100; // TODO related to AR
        self.followFadeOutTime = 100;
        self.ballFadeOutTime = 100;
        self.objectDespawnTime = 2000;
        self.backgroundFadeTime = 3000;

        if (Hash.timestamp()) {
            self.offset = +Hash.timestamp();
        }

        setPlayerActions(self);


        self.paused = false;
        this.pause = function() {
            // this.osu.audio.pause();
            // this.game.paused = true;
        };
        this.resume = function() {
            // this.osu.audio.resume();
            // this.game.paused = false;
        };

        // adjust volume
        if (game.allowMouseScroll) {
            self.game.window.addEventListener('wheel', function(e) {
                self.game.masterVolume -= e.deltaY * 0.01;
                if (self.game.masterVolume < 0) {
                    self.game.masterVolume = 0;
                } 
                if (self.game.masterVolume > 1) {
                    self.game.masterVolume = 1;
                }
                self.osu.audio.gain.gain.value = self.game.musicVolume * self.game.masterVolume;
                // TODO: Visualization
            });
        }
        self.osu.audio.gain.gain.value = self.game.musicVolume * self.game.masterVolume;

        // pause
        window.addEventListener("keyup", function(e) {
            if (e.keyCode === 32) {
                if (!self.game.paused) {
                    self.pause();
                }
                else {
                    self.resume();
                }
            }
            // TODO: Visualization
        });

        this.createBackground = function(){
            // Load background if possible
            self.backgroundDim = new PIXI.Graphics();
            self.backgroundDim.alpha = 0;
            self.backgroundDim.beginFill(0);
            self.backgroundDim.drawRect(0, 0, self.game.window.innerWidth, self.game.window.innerHeight);
            self.backgroundDim.endFill();
            self.game.stage.addChild(self.backgroundDim);
            if (self.track.events.length != 0) {
                self.ready = false;
                var file = self.track.events[0][2];
                if (track.events[0][0] === "Video") {
                    file = self.track.events[1][2];
                }
                file = file.substr(1, file.length - 2);
                entry = osu.zip.getChildByName(file);
                if (entry) {
                    entry.getBlob("image/jpeg", function (blob) {
                        var uri = URL.createObjectURL(blob);
                        var image = PIXI.Texture.fromImage(uri);
                        self.background = new PIXI.Sprite(image);
                        self.background.x = self.background.y = 0;
                        self.background.width = self.game.window.innerWidth;
                        self.background.height = self.game.window.innerHeight;
                        // var blurFilter = new PIXI.filters.KawaseBlurFilter(4,3,true);
                        // self.background.filters = [blurFilter];
                        self.game.stage.addChildAt(self.background, 0); // put background under dim layer
                        self.ready = true;
                        self.start();
                    });
                } else  {
                    self.ready = true;
                }
            }
        };
        self.createBackground();

        // load combo colors
        var combos = [];
        for (var i = 0; i < track.colors.length; i++) {
            var color = track.colors[i];
            combos.push(((+color[0]) << 16) |
                        ((+color[1]) << 8) |
                        ((+color[2]) << 0));
        }

        this.createScoreOverlay = function(){
            // 5-digit score
            self.scoreDigit = [];
            for (let i=1; i<=5; ++i)
            {
                var digit = new PIXI.Sprite(Skin['score-0.png']);
                digit.anchor.x = digit.anchor.y = 0.5;
                digit.x = game.window.innerWidth - (i * scoreCharWidth);
                digit.y = scoreCharHeight;
                self.game.stage.addChild(digit);
                self.scoreDigit[i-1] = digit;
            }
        };
        self.createScoreOverlay();

        this.updateScoreOverlay = function(){
            var numbers = self.game.score.points.toString().split('').reverse();
            var len = numbers.length;
            for (let i=0; i<5; ++i) {
                if (len > i) {
                    self.scoreDigit[i].texture = Skin["score-" + numbers[i] + '.png'];
                }
            }
        }

        // creating hit objects
        this.createHitCircle = function(hit, objects = hit.objects) {
            var index = hit.index + 1;

            var base = hit.base = new PIXI.Sprite(Skin["hitcircle.png"]);
            base.scale.x = base.scale.y = this.hitSpriteScale;
            base.anchor.x = base.anchor.y = 0.5;
            base.x = gfx.xoffset + hit.x * gfx.width;
            base.y = gfx.yoffset + hit.y * gfx.height;
            base.depth = 4.9999 - 0.0001 * hit.hitIndex;
            hit.basex = base.x;
            hit.basey = base.y;
            base.alpha = 0;
            base.tint = combos[hit.combo % combos.length];

            var overlay = new PIXI.Sprite(Skin["hitcircleoverlay.png"]);
            overlay.scale.x = overlay.scale.y = this.hitSpriteScale;
            overlay.anchor.x = overlay.anchor.y = 0.5;
            overlay.x = gfx.xoffset + hit.x * gfx.width;
            overlay.y = gfx.yoffset + hit.y * gfx.height;
            overlay.depth = 4.9999 - 0.0001 * hit.hitIndex;
            overlay.alpha = 0;

            var burst = hit.burst = new PIXI.Sprite(Skin["hitburst.png"]);
            burst.scale.x = burst.scale.y = this.hitSpriteScale;
            burst.anchor.x = burst.anchor.y = 0.5;
            burst.x = gfx.xoffset + hit.x * gfx.width;
            burst.y = gfx.yoffset + hit.y * gfx.height;
            burst.depth = 4.9999 - 0.0001 * hit.hitIndex;
            burst.visible = false;

            var approach;
            if (index > 0) { // index == -1 is used for slider ends
                hit.approach = approach = new PIXI.Sprite(Skin["approachcircle.png"]);
                approach.alpha = 0;
                approach.anchor.x = approach.anchor.y = 0.5;
                approach.x = gfx.xoffset + hit.x * gfx.width;
                approach.y = gfx.yoffset + hit.y * gfx.height;
                approach.depth = 6 + 0.0001 * hit.hitIndex;
                approach.tint = combos[hit.combo % combos.length];
            }

            if (!hit.objectWin){
                hit.objectWin = new PIXI.Sprite(Skin["hit0.png"]);
                hit.objectWin.scale.x = hit.objectWin.scale.y = this.hitSpriteScale;
                hit.objectWin.anchor.x = hit.objectWin.anchor.y = 0.5;
                hit.objectWin.x = gfx.xoffset + hit.x * gfx.width;
                hit.objectWin.y = gfx.yoffset + hit.y * gfx.height;
                hit.objectWin.depth = 2 + 0.0001 * hit.hitIndex;
                hit.objectWin.alpha = 0;
            }

            objects.push(base);
            objects.push(overlay);
            objects.push(burst);
            if (index > 0) {
                objects.push(approach);
            }

            if (index <= 9 && index > 0) {
                var number = new PIXI.Sprite(Skin["default-" + index + ".png"]);
                number.alpha = 0;
                number.anchor.x = number.anchor.y = 0.5;
                number.x = gfx.xoffset + hit.x * gfx.width;
                number.y = gfx.yoffset + hit.y * gfx.height;
                number.scale.x = number.scale.y = this.hitSpriteScale;
                number.depth = 4.9999-0.0001*hit.hitIndex;
                objects.push(number);
            } else if (index <= 99 && index > 0) {
                var numberA = new PIXI.Sprite(Skin["default-" + (index % 10) + ".png"]);
                numberA.alpha = 0;
                numberA.anchor.x = 0.0 + 0.1;
                numberA.anchor.y = 0.5;
                numberA.x = gfx.xoffset + hit.x * gfx.width;
                numberA.y = gfx.yoffset + hit.y * gfx.height;
                numberA.scale.x = numberA.scale.y = 0.9 * this.hitSpriteScale;
                numberA.depth = 4.9999-0.0001*hit.hitIndex;
                objects.push(numberA);

                var numberB = new PIXI.Sprite(Skin["default-" +
                    ((index - (index % 10)) / 10) + ".png"]);
                numberB.alpha = 0;
                numberB.anchor.x = 1.0 + 0.1;
                numberB.anchor.y = 0.5;
                numberB.x = gfx.xoffset + hit.x * gfx.width;
                numberB.y = gfx.yoffset + hit.y * gfx.height;
                numberB.scale.x = numberB.scale.y = 0.9 * this.hitSpriteScale;
                numberB.depth = 4.9999-0.0001*hit.hitIndex;
                objects.push(numberB);
            }
            // Note: combos > 99 hits are unsupported
        }

        this.createSlider = function(hit) {
            hit.lastrep = 0; // for hitsound counting
            hit.sliderTime = hit.timing.millisecondsPerBeat * (hit.pixelLength / track.difficulty.SliderMultiplier) / 100;
            hit.sliderTimeTotal = hit.sliderTime * hit.repeat;

            // get slider curve
            if (hit.sliderType === SLIDER_PERFECT_CURVE && hit.keyframes.length == 2) {
                // handle straight P slider
                // Vec2f nora = new Vec2f(sliderX[0] - x, sliderY[0] - y).nor();
                // Vec2f norb = new Vec2f(sliderX[0] - sliderX[1], sliderY[0] - sliderY[1]).nor();
                // if (Math.abs(norb.x * nora.y - norb.y * nora.x) < 0.00001)
                //     return new LinearBezier(this, false, scaled);  // vectors parallel, use linear bezier instead
                // else
                hit.curve = new CircumscribedCircle(hit, gfx.width / gfx.height);
                if (hit.curve.length == 0) // fallback
                    hit.curve = new LinearBezier(hit, hit.sliderType === SLIDER_LINEAR);
            }
            else
                hit.curve = new LinearBezier(hit, hit.sliderType === SLIDER_LINEAR);
            if (hit.curve.length < 2)
                console.log("Error: slider curve calculation failed");
            
            // Add follow circle, which lies visually under slider body
            var follow = hit.follow = new PIXI.Sprite(Skin["sliderfollowcircle.png"]);
            follow.scale.x = follow.scale.y = this.hitSpriteScale;
            follow.visible = false;
            follow.alpha = 0;
            follow.anchor.x = follow.anchor.y = 0.5;
            follow.manualAlpha = true;
            follow.blendMode = PIXI.BLEND_MODES.ADD;
            follow.depth = 5;
            hit.objects.push(follow);
            hit.followSize = 1; // [1,2] current follow circle size relative to hitcircle

            // create slider body
            var body = new SliderMesh(hit.curve.curve,
                this.circleRadius,
                {
                    x: gfx.xoffset, y: gfx.yoffset,
                    width: gfx.width, height: gfx.height,
                    osuWidth: 512, osuHeight: 384,
                    windowWidth: game.window.innerWidth,
                    windowHeight: game.window.innerHeight
                },
                combos[hit.combo % combos.length]);
            body.alpha = 0;
            body.depth = 4.9999-0.0001*hit.hitIndex;
            hit.objects.push(body);

            // Add slider ball
            var ball = hit.ball = new PIXI.Sprite(Skin["sliderb.png"]);
            ball.scale.x = ball.scale.y = this.hitSpriteScale;
            ball.visible = false;
            ball.alpha = 0;
            ball.anchor.x = ball.anchor.y = 0.5;
            ball.tint = 0xFFFFFF;
            ball.manualAlpha = true;
            ball.depth = 5;
            hit.objects.push(ball);

            // create hitcircle at head
            hit.hitcircleObjects = new Array();
            self.createHitCircle(hit, hit.hitcircleObjects); // Near end
            _.each(hit.hitcircleObjects, function(o){hit.objects.push(o);});

            var burst = hit.burst = new PIXI.Sprite(Skin["hitburst.png"]);
            burst.scale.x = burst.scale.y = this.hitSpriteScale;
            burst.anchor.x = burst.anchor.y = 0.5;
            burst.x = gfx.xoffset + hit.x * gfx.width;
            burst.y = gfx.yoffset + hit.y * gfx.height;
            burst.depth = 4.9999 - 0.0001 * hit.hitIndex;
            burst.visible = false;
            hit.objects.push(burst);

            let endPoint = hit.curve.curve[hit.curve.curve.length-1];
            let endPoint2 = hit.curve.curve[hit.curve.curve.length-2];
            // curve points are of about-same distance, so these 2 points should be different
            let endAngle = Math.atan2(endPoint.y - endPoint2.y, endPoint.x - endPoint2.x);

            if (hit.repeat > 1) {
                // Add reverse symbol
                var reverse = hit.reverse = new PIXI.Sprite(Skin["reversearrow.png"]);
                reverse.scale.x = reverse.scale.y = this.hitSpriteScale;
                reverse.alpha = 0;
                reverse.anchor.x = reverse.anchor.y = 0.5;
                reverse.x = gfx.xoffset + endPoint.x * gfx.width;
                reverse.y = gfx.yoffset + endPoint.y * gfx.height;
                reverse.tint = 0xFFFFFF;
                reverse.rotation = endAngle + Math.PI;
                reverse.depth = 4.9999-0.0001*hit.hitIndex;
                hit.objects.push(reverse);
            }
            if (hit.repeat > 2) {
                // Add another reverse symbol at
                var reverse = hit.reverse_b = new PIXI.Sprite(Skin["reversearrow.png"]);
                reverse.scale.x = reverse.scale.y = this.hitSpriteScale;
                reverse.alpha = 0;
                reverse.anchor.x = reverse.anchor.y = 0.5;
                reverse.x = gfx.xoffset + hit.x * gfx.width;
                reverse.y = gfx.yoffset + hit.y * gfx.height;
                reverse.tint = 0xFFFFFF;
                reverse.rotation = endAngle;
                reverse.visible = false; // Only visible when it's the next end to hit
                reverse.depth = 4.9999-0.0001*hit.hitIndex;
                hit.objects.push(reverse);
            }
        }

        this.createSpinner = function(hit) {
            hit.x = 0.5;
            hit.y = 0.5;
            hit.rotation = 0;
            hit.clicked = false;

            var base = hit.base = new PIXI.Sprite(Skin["spinner.png"]);
            base.scale.x = base.scale.y = gfx.width / 768;
            base.anchor.x = base.anchor.y = 0.5;
            base.x = gfx.xoffset + hit.x * gfx.width;
            base.y = gfx.yoffset + hit.y * gfx.height;
            base.depth = 4.9999 - 0.0001 * (hit.hitIndex || 1);
            base.alpha = 0;

            if (!hit.objectWin){
                hit.objectWin = new PIXI.Sprite(Skin["hit0.png"]);
                hit.objectWin.scale.x = hit.objectWin.scale.y = this.hitSpriteScale;
                hit.objectWin.anchor.x = hit.objectWin.anchor.y = 0.5;
                hit.objectWin.x = gfx.xoffset + hit.x * gfx.width;
                hit.objectWin.y = gfx.yoffset + hit.y * gfx.height;
                hit.objectWin.depth = 2 + 0.0001 * hit.hitIndex;
                hit.objectWin.alpha = 0;
            }
            hit.objects.push(base);
        }

        this.populateHit = function(hit) {
            // Creates PIXI objects for a given hit
            this.currentHitIndex += 1;
            hit.hitIndex = this.currentHitIndex;
            // find latest timing point that's not later than this hit
            var timing = track.timingPoints[0];
            // select later one if timingPoints coincide
            for (var i = 1; i < track.timingPoints.length; i++) {
                var t = track.timingPoints[i];
                if (t.offset > hit.time) {
                    break;
                }
                timing = t;
            }
            hit.timing = timing;

            hit.objects = [];
            hit.score = -1;
            switch (hit.type) {
                case "circle":
                    self.createHitCircle(hit);
                    break;
                case "slider":
                    self.createSlider(hit);
                    break;
                case "spinner":
                    self.createSpinner(hit);
                    break;
            }
        }

        for (var i = 0; i < this.hits.length; i++) {
            this.populateHit(this.hits[i]); // Prepare sprites and such
        }

        // hit result handling
        this.playHitsound = function playHitsound(hit, id) {
            let volume = self.game.masterVolume * self.game.effectVolume * (hit.hitSample.volume || hit.timing.volume) / 100;
            let defaultSet = hit.timing.sampleSet || self.game.sampleSet;
            function playHit(bitmask, normalSet, additionSet) {
                // The normal sound is always played
                self.game.sample[normalSet].hitnormal.volume = volume;
                self.game.sample[normalSet].hitnormal.play();
                if (bitmask & 2) {
                    self.game.sample[additionSet].hitwhistle.volume = volume;
                    self.game.sample[additionSet].hitwhistle.play();
                }
                if (bitmask & 4) {
                    self.game.sample[additionSet].hitfinish.volume = volume;
                    self.game.sample[additionSet].hitfinish.play();
                }
                if (bitmask & 8) {
                    self.game.sample[additionSet].hitclap.volume = volume;
                    self.game.sample[additionSet].hitclap.play();
                }
            }
            if (hit.type == 'circle') {
                let toplay = hit.hitSound;
                let normalSet = hit.hitSample.normalSet || defaultSet;
                let additionSet = hit.hitSample.additionSet || normalSet;
                playHit(toplay, normalSet, additionSet);
            }
            if (hit.type == 'slider') {
                let toplay = hit.edgeHitsounds[id];
                let normalSet = hit.edgeSets[id].normalSet || defaultSet;
                let additionSet = hit.edgeSets[id].additionSet || normalSet;
                playHit(toplay, normalSet, additionSet);
            }
        };

        this.hitSuccess = function hitSuccess(hit, points){
            self.playHitsound(hit, 0);
            hit.score = points;
            self.game.score.points += points;
            self.game.score.goodClicks += 1;
            self.updateScoreOverlay();
            if (hit.objectWin)
                hit.objectWin.texture = Skin["hit" + points + ".png"];
        };

        // hit object updating
        var futuremost = 0, current = 0;
        if (self.track.hitObjects.length > 0) {
            futuremost = self.track.hitObjects[0].time;
        }
        this.updateUpcoming = function(timestamp) {
            // Cache the next ten seconds worth of hit objects
            while (current < self.hits.length && futuremost < timestamp + 10000) {
                var hit = self.hits[current++];
                let findindex = function(i) { // returning smallest j satisfying (self.game.stage.children[j].depth || 0)>=i
                    let l = 0, r = self.game.stage.children.length;
                    while (l+1<r) {
                        let m = Math.floor((l+r)/2)-1;
                        if ((self.game.stage.children[m].depth || 0) < i)
                            l = m+1;
                        else
                            r = m+1;
                    }
                    return l;
                }
                if (hit.objectWin){
                    self.game.stage.addChildAt(hit.objectWin, findindex(hit.objectWin.depth || 0.0001));
                }
                for (var i = hit.objects.length - 1; i >= 0; i--) {
                    self.game.stage.addChildAt(hit.objects[i], findindex(hit.objects[i].depth || 0.0001));
                }
                self.upcomingHits.push(hit);
                if (hit.time > futuremost) {
                    futuremost = hit.time;
                }
            }
            for (var i = 0; i < self.upcomingHits.length; i++) {
                var hit = self.upcomingHits[i];
                var diff = hit.time - timestamp;
                var despawn = -this.objectDespawnTime;
                if (hit.type === "slider") {
                    despawn -= hit.sliderTimeTotal;
                }
                if (hit.type === "spinner") {
                    despawn -= hit.endTime - hit.time;
                }
                if (diff < despawn) {
                    self.upcomingHits.splice(i, 1);
                    i--;
                    _.each(hit.objects, function(o) { self.game.stage.removeChild(o); o.destroy(); });
                    if (hit.objectWin){
                      self.game.stage.removeChild(hit.objectWin); hit.objectWin.destroy();
                    }
                }
            }
        }

        this.fadeOutEasing = function(t) { // [0..1] -> [1..0]
            if (t <= 0) return 1;
            if (t > 1) return 0;
            return 1 - Math.sin(t * Math.PI/2);
        }

        this.updateHitCircle = function(hit, time) {
            let diff = hit.time - time; // milliseconds before time of circle
            // calculate opacity of circle
            let alpha = 0;
            let noteFullAppear = this.approachTime - this.objectFadeInTime; // duration of opaque hit circle when approaching
            let approachFullAppear = this.approachTime - this.approachFadeInTime; // duration of opaque approach circle when approaching

            if (diff <= this.approachTime && diff > noteFullAppear) { // fading in
                alpha = (this.approachTime - diff) / this.objectFadeInTime;
                _.each(hit.objects, function(o) { o.alpha = alpha; });
            }
            else if (hit.score > 0) { // clicked
                // burst light
                if (!hit.burst.visible) {
                    _.each(hit.objects, function(o) { o.visible = false; });
                    hit.burst.visible = true;
                }
                let timeAfter = time - hit.clickTime;
                alpha = Math.max(0, 1 - timeAfter / this.circleFadeOutTime);
                let scale = (1 + 0.4 * timeAfter / this.circleFadeOutTime) * this.hitSpriteScale;
                hit.burst.alpha = alpha;
                hit.burst.scale.x = hit.burst.scale.y = scale;
            }
            else if (diff <= noteFullAppear && -diff <= this.MehTime) { // before click
                alpha = 1;
                _.each(hit.objects, function(o) { o.alpha = alpha; });
            }
            else if (-diff > this.MehTime) { // missed
                hit.score = 0;
                let timeAfter = time - hit.time - this.MehTime;
                alpha = this.fadeOutEasing(timeAfter / this.circleFadeOutTime);
                _.each(hit.objects, function(o) { o.alpha = alpha; });
            }

            // calculate size of approach circle
            if (diff <= this.approachTime && diff > 0) { // approaching
                let scale = (diff / this.approachTime * this.approachScale + 1) * 0.48 * this.hitSpriteScale;
                hit.approach.scale.x = scale;
                hit.approach.scale.y = scale;
            } else {
                hit.approach.scale.x = hit.approach.scale.y = 0.48 * this.hitSpriteScale;
            }

            // display hit score
            if (hit.score > 0 || time > hit.time + this.MehTime){
              hit.objectWin.alpha = this.fadeOutEasing(-diff / this.scoreFadeOutTime);
              hit.objectWin.scale.x = this.hitSpriteScale;
              hit.objectWin.scale.y = this.hitSpriteScale;
            }

            // calculate opacity of approach circle
            if (diff <= this.approachTime && diff > approachFullAppear) { // approach circle fading in
                alpha = (this.approachTime - diff) / this.approachFadeInTime;
            }
            else if (diff <= approachFullAppear && diff > 0) { // approach circle opaque, just shrinking
                alpha = 1;
            }
            hit.approach.alpha = alpha;
        }

        this.updateSlider = function(hit, time) {
            let diff = hit.time - time; // milliseconds before hit.time
            // calculate opacity of slider
            let alpha = 0;
            let noteFullAppear = this.approachTime - this.objectFadeInTime; // duration of opaque hit circle when approaching
            let approachFullAppear = this.approachTime - this.approachFadeInTime; // duration of opaque approach circle when approaching
            if (diff <= this.approachTime && diff > noteFullAppear) {
                // Fade in (before hit)
                alpha = (this.approachTime - diff) / this.objectFadeInTime;
            } else if (diff <= noteFullAppear && diff > -hit.sliderTimeTotal) {
                // approaching or During slide
                alpha = 1;
            } else if (-diff > 0 && -diff < this.sliderFadeOutTime + hit.sliderTimeTotal) {
                // Fade out (after slide)
                alpha = this.fadeOutEasing((-diff - hit.sliderTimeTotal) / this.sliderFadeOutTime);
            }
            // apply opacity
            _.each(hit.objects, function(o) {
                if (_.isUndefined(o._manualAlpha)) {
                    o.alpha = alpha;
                }
            });

            // calculate opacity of approach circle
            if (diff <= this.approachTime && diff > approachFullAppear) { // approach circle fading in
                alpha = (this.approachTime - diff) / this.approachFadeInTime;
            }
            else if (diff <= approachFullAppear && diff > 0) { // approach circle opaque, just shrinking
                alpha = 1;
            }
            hit.approach.alpha = alpha;

            // calculate size of approach circle
            if (diff >= 0 && diff <= this.approachTime) { // approaching
                let scale = (diff / this.approachTime * this.approachScale + 1) * 0.48 * this.hitSpriteScale;
                hit.approach.scale.x = scale;
                hit.approach.scale.y = scale;
            } else {
                hit.approach.scale.x = hit.approach.scale.y = 0.48 * this.hitSpriteScale;
            }
            // calculate for hit circle
            if (hit.clickTime) { // clicked
                // burst light
                if (!hit.burst.visible) {
                    _.each(hit.hitcircleObjects, function(o) { o.visible = false; });
                    hit.burst.visible = true;
                    hit.approach.visible = false;
                }
                let timeAfter = time - hit.clickTime;
                alpha = Math.max(0, 1 - timeAfter / this.circleFadeOutTime);
                let scale = (1 + 0.4 * timeAfter / this.circleFadeOutTime) * this.hitSpriteScale;
                hit.burst.alpha = alpha;
                hit.burst.scale.x = hit.burst.scale.y = scale;
            }
            else if (-diff > this.MehTime) { // missed
                let timeAfter = -diff - this.MehTime;
                alpha = this.fadeOutEasing(timeAfter / this.circleFadeOutTime);
                _.each(hit.hitcircleObjects, function(o) { o.alpha = alpha; });
                hit.approach.alpha = alpha;
            }

            function resizeFollow(hit, time, dir) {
                if (!hit.followLasttime) hit.followLasttime = time;
                if (!hit.followLinearSize) hit.followLinearSize = 1;
                let dt = time - hit.followLasttime;
                hit.followLinearSize = Math.max(1, Math.min(2, hit.followLinearSize + dt * dir));
                hit.followSize = hit.followLinearSize; // easing can happen here
                hit.followLasttime = time;
            }

            if (-diff >= 0 && -diff <= this.sliderFadeOutTime + hit.sliderTimeTotal) { // after hit.time & before slider disappears
                // t: position relative to slider duration
                let t = -diff / hit.sliderTime;
                if (hit.repeat > 1) {
                    hit.currentRepeat = Math.ceil(t);
                }
                // clamp t
                let atEnd = false;
                if (Math.floor(t) > hit.lastrep)
                {
                    hit.lastrep = Math.floor(t);
                    if (hit.lastrep > 0 && hit.lastrep <= hit.repeat)
                        atEnd = true;
                }
                if (t > hit.repeat)
                    t = hit.repeat;
                if (hit.repeat > 1) {
                    if (hit.currentRepeat % 2 == 0) {
                        t = -t
                    }
                    t = t - Math.floor(t);
                }

                // Update ball and follow circle position
                let at = hit.curve.pointAt(t);
                let atx = at.x * gfx.width + gfx.xoffset;
                let aty = at.y * gfx.height + gfx.yoffset;
                hit.follow.x = atx;
                hit.follow.y = aty;
                hit.ball.x = atx;
                hit.ball.y = aty;
                _.each(hit.hitcircleObjects, function(o) { o.x = atx; o.y = aty; });
                hit.approach.x = atx;
                hit.approach.y = aty;

                let dx = game.mouseX - atx;
                let dy = game.mouseY - aty;
                let followPixelSize = hit.followSize * this.circleRadiusPixel;
                let isfollowing = dx*dx + dy*dy <= followPixelSize * followPixelSize;

                if (atEnd && this.game.down && isfollowing)
                    self.playHitsound(hit, hit.lastrep);

                // sliderball & follow circle Animation
                if (-diff >= 0 && -diff <= hit.sliderTimeTotal) {
                    // slider ball immediately emerges
                    hit.ball.visible = true;
                    hit.ball.alpha = 1;
                    // follow circie immediately emerges and gradually enlarges
                    hit.follow.visible = true;
                    if (this.game.down && isfollowing)
                        resizeFollow(hit, time, 1 / this.followZoomInTime); // expand 
                    else
                        resizeFollow(hit, time, -1 / this.followZoomInTime); // shrink
                    let followscale = hit.followSize * 0.45 * this.hitSpriteScale;
                    hit.follow.scale.x = hit.follow.scale.y = followscale;
                    hit.follow.alpha = hit.followSize - 1;
                }
                let timeAfter = -diff - hit.sliderTimeTotal;
                if (timeAfter > 0) {
                    resizeFollow(hit, time, -1 / this.followZoomInTime); // shrink
                    let followscale = hit.followSize * 0.45 * this.hitSpriteScale;
                    hit.follow.scale.x = hit.follow.scale.y = followscale;
                    hit.follow.alpha = hit.followSize - 1;
                    hit.ball.alpha = this.fadeOutEasing(timeAfter / this.ballFadeOutTime);
                    let ballscale = (1 + 0.15 * timeAfter / this.ballFadeOutTime) * this.hitSpriteScale;
                    hit.ball.scale.x = hit.ball.scale.y = ballscale;
                }

                // reverse arrow
                if (hit.currentRepeat) {
                    let finalrepfromA = hit.repeat - hit.repeat % 2; // even
                    let finalrepfromB = hit.repeat-1 + hit.repeat % 2; // odd
                    hit.reverse.visible = (hit.currentRepeat < finalrepfromA);
                    if (hit.reverse_b)
                        hit.reverse_b.visible = (hit.currentRepeat < finalrepfromB);
                    // TODO reverse arrow fade out animation
                }
            }

            
            // display hit score
            if (hit.score > 0 || time > hit.time + hit.sliderTimeTotal + this.MehTime ){
              hit.objectWin.alpha = this.fadeOutEasing((-diff - hit.sliderTimeTotal) / this.scoreFadeOutTime);
              hit.objectWin.scale.x = this.hitSpriteScale;
              hit.objectWin.scale.y = this.hitSpriteScale;
            }
        }

        this.updateSpinner = function(hit, time) {
            // update rotation
            if (time >= hit.time && time <= hit.endTime) {
                if (this.game.down) {
                    let Xr = this.game.mouseX - gfx.xoffset - gfx.width/2;
                    let Yr = this.game.mouseY - gfx.yoffset - gfx.height/2;
                    let mouseAngle = Math.atan2(Yr, Xr);
                    if (!hit.clicked) {
                        hit.clicked = true;
                    }
                    else {
                        hit.rotation += mouseAngle - hit.lastAngle;
                    }
                    hit.lastAngle = mouseAngle;
                }
                else {
                    hit.clicked = false;
                }
            }

            let diff = hit.time - time; // milliseconds before time of circle
            // calculate opacity of circle
            let alpha = (time >= hit.time && time <= hit.endTime)? 1: 0;

            hit.base.rotation = hit.rotation;
            hit.base.alpha = alpha;
           
            // // display hit score
            // if (hit.score > 0 || time > hit.time + this.TIME_ALLOWED){
            //   hit.objectWin.alpha = this.fadeOutEasing(-diff / this.scoreFadeOutTime);
            //   hit.objectWin.scale.x = this.hitSpriteScale;
            //   hit.objectWin.scale.y = this.hitSpriteScale;
            // }
        }

        this.updateHitObjects = function(time) {
            self.updateUpcoming(time);
            for (var i = self.upcomingHits.length - 1; i >= 0; i--) {
                var hit = self.upcomingHits[i];
                switch (hit.type) {
                    case "circle":
                        self.updateHitCircle(hit, time);
                        break;
                    case "slider":
                        self.updateSlider(hit, time);
                        break;
                    case "spinner":
                        self.updateSpinner(hit, time);
                        break;
                }
            }
        }

        this.updateBackground = function(time) {
            var fade = self.game.backgroundDimRate;
            if (self.track.general.PreviewTime !== 0 && time < self.track.general.PreviewTime) {
                var diff = self.track.general.PreviewTime - time;
                if (diff < self.backgroundFadeTime) {
                    fade = 1 - diff / (self.backgroundFadeTime);
                    fade *= self.game.backgroundDimRate;
                } else {
                    fade = 0;
                }
            }
            self.backgroundDim.alpha = fade;
        }

        this.render = function(timestamp) {
            var time = osu.audio.getPosition() * 1000 + self.offset;
            this.updateBackground(time);
            if (time !== 0) {
                self.updateHitObjects(time);
                self.game.updatePlayerActions(time);
                if (self.osu.audio.playing && false) { // TODO: Better way of updating this
                    Hash.timestamp(Math.floor(time));
                }
            }
        }

        this.teardown = function() {
            // TODO
        }

        this.start = function() {
            self.started = true;
            if (!self.ready) {
                return;
            }
            setTimeout(function() {
                self.osu.audio.play(self.offset);
            }, 1000);
        };

        self.start();
    }
    
    return Playback;
});