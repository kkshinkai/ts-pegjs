"use strict";

// Base: (original file: generate-bycode.js for codegen JS)

var asts = require("peggy/lib/compiler/asts");
var js = require("./js");
var op = require("peggy/lib/compiler/opcodes");
var visitor = require("peggy/lib/compiler/visitor");

// Generates bytecode.
//
// Instructions
// ============
//
// Stack Manipulation
// ------------------
//
//  [0] PUSH c
//
//        stack.push(consts[c]);
//
//  [1] PUSH_UNDEFINED
//
//        stack.push(undefined);
//
//  [2] PUSH_NULL
//
//        stack.push(null);
//
//  [3] PUSH_FAILED
//
//        stack.push(FAILED);
//
//  [4] PUSH_EMPTY_ARRAY
//
//        stack.push([]);
//
//  [5] PUSH_CURR_POS
//
//        stack.push(currPos);
//
//  [6] POP
//
//        stack.pop();
//
//  [7] POP_CURR_POS
//
//        currPos = stack.pop();
//
//  [8] POP_N n
//
//        stack.pop(n);
//
//  [9] NIP
//
//        value = stack.pop();
//        stack.pop();
//        stack.push(value);
//
// [10] APPEND
//
//        value = stack.pop();
//        array = stack.pop();
//        array.push(value);
//        stack.push(array);
//
// [11] WRAP n
//
//        stack.push(stack.pop(n));
//
// [12] TEXT
//
//        stack.push(input.substring(stack.pop(), currPos));
//
// [36] PLUCK n, k, p1, ..., pK
//
//        value = [stack[p1], ..., stack[pK]]; // when k != 1
//        -or-
//        value = stack[p1];                   // when k == 1
//
//        stack.pop(n);
//        stack.push(value);
//
// Conditions and Loops
// --------------------
//
// [13] IF t, f
//
//        if (stack.top()) {
//          interpret(ip + 3, ip + 3 + t);
//        } else {
//          interpret(ip + 3 + t, ip + 3 + t + f);
//        }
//
// [14] IF_ERROR t, f
//
//        if (stack.top() === FAILED) {
//          interpret(ip + 3, ip + 3 + t);
//        } else {
//          interpret(ip + 3 + t, ip + 3 + t + f);
//        }
//
// [15] IF_NOT_ERROR t, f
//
//        if (stack.top() !== FAILED) {
//          interpret(ip + 3, ip + 3 + t);
//        } else {
//          interpret(ip + 3 + t, ip + 3 + t + f);
//        }
//
// [16] WHILE_NOT_ERROR b
//
//        while(stack.top() !== FAILED) {
//          interpret(ip + 2, ip + 2 + b);
//        }
//
// Matching
// --------
//
// [17] MATCH_ANY a, f, ...
//
//        if (input.length > currPos) {
//          interpret(ip + 3, ip + 3 + a);
//        } else {
//          interpret(ip + 3 + a, ip + 3 + a + f);
//        }
//
// [18] MATCH_STRING s, a, f, ...
//
//        if (input.substr(currPos, consts[s].length) === consts[s]) {
//          interpret(ip + 4, ip + 4 + a);
//        } else {
//          interpret(ip + 4 + a, ip + 4 + a + f);
//        }
//
// [19] MATCH_STRING_IC s, a, f, ...
//
//        if (input.substr(currPos, consts[s].length).toLowerCase() === consts[s]) {
//          interpret(ip + 4, ip + 4 + a);
//        } else {
//          interpret(ip + 4 + a, ip + 4 + a + f);
//        }
//
// [20] MATCH_REGEXP r, a, f, ...
//
//        if (consts[r].test(input.charAt(currPos))) {
//          interpret(ip + 4, ip + 4 + a);
//        } else {
//          interpret(ip + 4 + a, ip + 4 + a + f);
//        }
//
// [21] ACCEPT_N n
//
//        stack.push(input.substring(currPos, n));
//        currPos += n;
//
// [22] ACCEPT_STRING s
//
//        stack.push(consts[s]);
//        currPos += consts[s].length;
//
// [23] FAIL e
//
//        stack.push(FAILED);
//        fail(consts[e]);
//
// Calls
// -----
//
// [24] LOAD_SAVED_POS p
//
//        savedPos = stack[p];
//
// [25] UPDATE_SAVED_POS
//
//        savedPos = currPos;
//
// [26] CALL f, n, pc, p1, p2, ..., pN
//
//        value = consts[f](stack[p1], ..., stack[pN]);
//        stack.pop(n);
//        stack.push(value);
//
// Rules
// -----
//
// [27] RULE r
//
//        stack.push(parseRule(r));
//
// Failure Reporting
// -----------------
//
// [28] SILENT_FAILS_ON
//
//        silentFails++;
//
// [29] SILENT_FAILS_OFF
//
//        silentFails--;
function generateBytecode(ast) {
  let consts = [];

  function addConst(value) {
    let index = consts.indexOf(value);

    return index === -1 ? consts.push(value) - 1 : index;
  }

  function addFunctionConst(params, code) {
    return addConst(
      "function(" + params.map(v => v + ": any").join(", ") + "): any {" + code + "}"
    );
  }

  function cloneEnv(env) {
    let clone = {};

    Object.keys(env).forEach(name => {
      clone[name] = env[name];
    });

    return clone;
  }

  function buildSequence() {
    return Array.prototype.concat.apply([], arguments);
  }

  function buildCondition(condCode, thenCode, elseCode) {
    return condCode.concat(
      [thenCode.length, elseCode.length],
      thenCode,
      elseCode
    );
  }

  function buildLoop(condCode, bodyCode) {
    return condCode.concat([bodyCode.length], bodyCode);
  }

  function buildCall(functionIndex, delta, env, sp) {
    let params = Object.keys(env).map(name => sp - env[name]);

    return [op.CALL, functionIndex, delta, params.length].concat(params);
  }

  function buildSimplePredicate(expression, negative, context) {
    return buildSequence(
      [op.PUSH_CURR_POS],
      [op.SILENT_FAILS_ON],
      generate(expression, {
        sp: context.sp + 1,
        env: cloneEnv(context.env),
        action: null
      }),
      [op.SILENT_FAILS_OFF],
      buildCondition(
        [negative ? op.IF_ERROR : op.IF_NOT_ERROR],
        buildSequence(
          [op.POP],
          [negative ? op.POP : op.POP_CURR_POS],
          [op.PUSH_UNDEFINED]
        ),
        buildSequence(
          [op.POP],
          [negative ? op.POP_CURR_POS : op.POP],
          [op.PUSH_FAILED]
        )
      )
    );
  }

  function buildSemanticPredicate(code, negative, context) {
    let functionIndex = addFunctionConst(Object.keys(context.env), code);

    return buildSequence(
      [op.UPDATE_SAVED_POS],
      buildCall(functionIndex, 0, context.env, context.sp),
      buildCondition(
        [op.IF],
        buildSequence(
          [op.POP],
          negative ? [op.PUSH_FAILED] : [op.PUSH_UNDEFINED]
        ),
        buildSequence(
          [op.POP],
          negative ? [op.PUSH_UNDEFINED] : [op.PUSH_FAILED]
        )
      )
    );
  }

  function buildAppendLoop(expressionCode) {
    return buildLoop(
      [op.WHILE_NOT_ERROR],
      buildSequence([op.APPEND], expressionCode)
    );
  }

  let generate = visitor.build({
    grammar(node) {
      node.rules.forEach(generate);

      node.consts = consts;
    },

    rule(node) {
      node.bytecode = generate(node.expression, {
        sp: -1,        // stack pointer
        env: {},      // mapping of label names to stack positions
        pluck: [],
        action: null   // action nodes pass themselves to children here
      });
    },

    named(node, context) {
      let nameIndex = addConst(
        "peg$otherExpectation(\"" + js.stringEscape(node.name) + "\")"
      );

      // The code generated below is slightly suboptimal because |FAIL| pushes
      // to the stack, so we need to stick a |POP| in front of it. We lack a
      // dedicated instruction that would just report the failure and not touch
      // the stack.
      return buildSequence(
        [op.SILENT_FAILS_ON],
        generate(node.expression, context),
        [op.SILENT_FAILS_OFF],
        buildCondition([op.IF_ERROR], [op.FAIL, nameIndex], [])
      );
    },

    choice(node, context) {
      function buildAlternativesCode(alternatives, context) {
        return buildSequence(
          generate(alternatives[0], {
            sp: context.sp,
            env: cloneEnv(context.env),
            action: null
          }),
          alternatives.length > 1
            ? buildCondition(
              [op.IF_ERROR],
              buildSequence(
                [op.POP],
                buildAlternativesCode(alternatives.slice(1), context)
              ),
              []
            )
            : []
        );
      }

      return buildAlternativesCode(node.alternatives, context);
    },

    action(node, context) {
      let env = cloneEnv(context.env);
      let emitCall = node.expression.type !== "sequence"
        || node.expression.elements.length === 0;
      let expressionCode = generate(node.expression, {
        sp: context.sp + (emitCall ? 1 : 0),
        env: env,
        action: node
      });
      let functionIndex = addFunctionConst(Object.keys(env), node.code);

      return emitCall
        ? buildSequence(
          [op.PUSH_CURR_POS],
          expressionCode,
          buildCondition(
            [op.IF_NOT_ERROR],
            buildSequence(
              [op.LOAD_SAVED_POS, 1],
              buildCall(functionIndex, 1, env, context.sp + 2)
            ),
            []
          ),
          [op.NIP]
        )
        : expressionCode;
    },

    sequence(node, context) {
      function buildElementsCode(elements, context) {
        if (elements.length > 0) {
          let processedCount = node.elements.length - elements.slice(1).length;

          return buildSequence(
            generate(elements[0], {
              sp: context.sp,
              env: context.env,
              pluck: context.pluck,
              action: null
            }),
            buildCondition(
              [op.IF_NOT_ERROR],
              buildElementsCode(elements.slice(1), {
                sp: context.sp + 1,
                env: context.env,
                pluck: context.pluck,
                action: context.action
              }),
              buildSequence(
                processedCount > 1 ? [op.POP_N, processedCount] : [op.POP],
                [op.POP_CURR_POS],
                [op.PUSH_FAILED]
              )
            )
          );
        } else {
          if (context.pluck.length > 0) {
            return buildSequence(
              [op.PLUCK, node.elements.length + 1, context.pluck.length],
              context.pluck.map(eSP => context.sp - eSP)
            );
          }

          if (context.action) {
            let functionIndex = addFunctionConst(
              Object.keys(context.env),
              context.action.code
            );

            return buildSequence(
              [op.LOAD_SAVED_POS, node.elements.length],
              buildCall(
                functionIndex,
                node.elements.length,
                context.env,
                context.sp
              ),
              [op.NIP]
            );
          } else {
            return buildSequence([op.WRAP, node.elements.length], [op.NIP]);
          }
        }
      }

      return buildSequence(
        [op.PUSH_CURR_POS],
        buildElementsCode(node.elements, {
          sp: context.sp + 1,
          env: context.env,
          pluck: [],
          action: context.action
        })
      );
    },

    labeled(node, context) {
      let env = context.env;
      const label = node.label;
      const sp = context.sp + 1;

      if (label) {
        env = cloneEnv(context.env);
        context.env[node.label] = sp;
      }

      if (node.pick) {
        context.pluck.push(sp);
      }

      return generate(node.expression, {
        sp: context.sp,
        env: env,
        action: null
      });
    },

    text(node, context) {
      return buildSequence(
        [op.PUSH_CURR_POS],
        generate(node.expression, {
          sp: context.sp + 1,
          env: cloneEnv(context.env),
          action: null
        }),
        buildCondition(
          [op.IF_NOT_ERROR],
          buildSequence([op.POP], [op.TEXT]),
          [op.NIP]
        )
      );
    },

    simple_and(node, context) {
      return buildSimplePredicate(node.expression, false, context);
    },

    simple_not(node, context) {
      return buildSimplePredicate(node.expression, true, context);
    },

    optional(node, context) {
      return buildSequence(
        generate(node.expression, {
          sp: context.sp,
          env: cloneEnv(context.env),
          action: null
        }),
        buildCondition(
          [op.IF_ERROR],
          buildSequence([op.POP], [op.PUSH_NULL]),
          []
        )
      );
    },

    zero_or_more(node, context) {
      let expressionCode = generate(node.expression, {
        sp: context.sp + 1,
        env: cloneEnv(context.env),
        action: null
      });

      return buildSequence(
        [op.PUSH_EMPTY_ARRAY],
        expressionCode,
        buildAppendLoop(expressionCode),
        [op.POP]
      );
    },

    one_or_more(node, context) {
      let expressionCode = generate(node.expression, {
        sp: context.sp + 1,
        env: cloneEnv(context.env),
        action: null
      });

      return buildSequence(
        [op.PUSH_EMPTY_ARRAY],
        expressionCode,
        buildCondition(
          [op.IF_NOT_ERROR],
          buildSequence(buildAppendLoop(expressionCode), [op.POP]),
          buildSequence([op.POP], [op.POP], [op.PUSH_FAILED])
        )
      );
    },

    group(node, context) {
      return generate(node.expression, {
        sp: context.sp,
        env: cloneEnv(context.env),
        action: null
      });
    },

    semantic_and(node, context) {
      return buildSemanticPredicate(node.code, false, context);
    },

    semantic_not(node, context) {
      return buildSemanticPredicate(node.code, true, context);
    },

    rule_ref(node) {
      return [op.RULE, asts.indexOfRule(ast, node.name)];
    },

    literal(node) {
      if (node.value.length > 0) {
        let stringIndex = addConst("\""
          + js.stringEscape(
            node.ignoreCase ? node.value.toLowerCase() : node.value
          )
          + "\""
        );
        let expectedIndex = addConst(
          "peg$literalExpectation("
          + "\"" + js.stringEscape(node.value) + "\", "
          + node.ignoreCase
          + ")"
        );

        // For case-sensitive strings the value must match the beginning of the
        // remaining input exactly. As a result, we can use |ACCEPT_STRING| and
        // save one |substr| call that would be needed if we used |ACCEPT_N|.
        return buildCondition(
          node.ignoreCase
            ? [op.MATCH_STRING_IC, stringIndex]
            : [op.MATCH_STRING, stringIndex],
          node.ignoreCase
            ? [op.ACCEPT_N, node.value.length]
            : [op.ACCEPT_STRING, stringIndex],
          [op.FAIL, expectedIndex]
        );
      } else {
        let stringIndex = addConst("\"\"");

        return [op.PUSH, stringIndex];
      }
    },

    class(node) {
      let regexp = "/^["
        + (node.inverted ? "^" : "")
        + node.parts.map(part =>
          Array.isArray(part)
            ? js.regexpClassEscape(part[0])
            + "-"
            + js.regexpClassEscape(part[1])
            : js.regexpClassEscape(part)
        ).join("")
        + "]/" + (node.ignoreCase ? "i" : "");
      let parts = "["
        + node.parts.map(part =>
          Array.isArray(part)
            ? "[\"" + js.stringEscape(part[0]) + "\", \"" + js.stringEscape(part[1]) + "\"]"
            : "\"" + js.stringEscape(part) + "\""
        ).join(", ")
        + "]";
      let regexpIndex = addConst(regexp);
      let expectedIndex = addConst(
        "peg$classExpectation("
        + parts + ", "
        + node.inverted + ", "
        + node.ignoreCase
        + ")"
      );

      return buildCondition(
        [op.MATCH_REGEXP, regexpIndex],
        [op.ACCEPT_N, 1],
        [op.FAIL, expectedIndex]
      );
    },

    any() {
      let expectedIndex = addConst("peg$anyExpectation()");

      return buildCondition(
        [op.MATCH_ANY],
        [op.ACCEPT_N, 1],
        [op.FAIL, expectedIndex]
      );
    }
  });

  generate(ast);
}

module.exports = generateBytecode;
