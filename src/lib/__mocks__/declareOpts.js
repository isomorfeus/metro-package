/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 *
 */
"use strict";

module.exports = function(declared) {
  return function(opts) {
    for (var p in declared) {
      if (opts[p] == null && declared[p].default != null) {
        opts[p] = declared[p].default;
      }
    }

    return opts;
  };
};
