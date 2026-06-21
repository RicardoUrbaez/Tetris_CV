(function () {
  "use strict";

  var classifier = {
    ready: false,
    status: "not-trained",
    labels: [],
    model: null,
    lastPrediction: null,

    train: function () {
      var samplesData = window.TETRIS_GESTURE_SAMPLES || {};
      var samples = samplesData.samples || [];
      if (!window.tf || samples.length < 20) {
        this.status = samples.length ? "tfjs-missing" : "no-samples";
        return Promise.resolve(false);
      }

      var labelMap = {};
      samples.forEach(function (sample) {
        if (sample && sample.label && !labelMap[sample.label]) labelMap[sample.label] = true;
      });
      this.labels = Object.keys(labelMap).sort();
      if (this.labels.length < 2) {
        this.status = "need-more-classes";
        return Promise.resolve(false);
      }

      var labelIndex = {};
      this.labels.forEach(function (label, index) { labelIndex[label] = index; });

      var xsData = samples.map(function (sample) { return sample.features; });
      var ysData = samples.map(function (sample) {
        var row = Array(classifier.labels.length).fill(0);
        row[labelIndex[sample.label]] = 1;
        return row;
      });

      var xs = tf.tensor2d(xsData);
      var ys = tf.tensor2d(ysData);

      var model = tf.sequential();
      model.add(tf.layers.dense({ units: 32, activation: "relu", inputShape: [samplesData.featureCount || 63] }));
      model.add(tf.layers.dropout({ rate: 0.15 }));
      model.add(tf.layers.dense({ units: this.labels.length, activation: "softmax" }));
      model.compile({
        optimizer: tf.train.adam(0.01),
        loss: "categoricalCrossentropy",
        metrics: ["accuracy"]
      });

      this.status = "training";
      return model.fit(xs, ys, {
        epochs: 28,
        batchSize: 32,
        shuffle: true,
        verbose: 0
      }).then(function () {
        xs.dispose();
        ys.dispose();
        classifier.model = model;
        classifier.ready = true;
        classifier.status = "ready";
        return true;
      }).catch(function (err) {
        xs.dispose();
        ys.dispose();
        classifier.status = "error";
        console.warn("[GestureClassifier] training failed", err);
        return false;
      });
    },

    predict: function (features) {
      if (!this.ready || !this.model || !features) return null;
      var output = tf.tidy(function () {
        var input = tf.tensor2d([features]);
        return classifier.model.predict(input).dataSync();
      });

      var bestIndex = 0;
      var bestScore = output[0] || 0;
      for (var i = 1; i < output.length; i++) {
        if (output[i] > bestScore) {
          bestScore = output[i];
          bestIndex = i;
        }
      }

      this.lastPrediction = {
        label: this.labels[bestIndex] || "unknown",
        confidence: bestScore
      };
      return this.lastPrediction;
    }
  };

  window.TetrisGestureClassifier = classifier;
  window.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () { classifier.train(); }, 300);
  });
})();
