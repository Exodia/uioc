/**
 * Created by exodia on 14-4-14.
 */

void function (define, global, undefined) {
    define(
        function (require) {
            var Container = require('./Container');
            var util = require('./util');
            var DependencyTree = require('./DependencyTree');
            var globalLoader = global.require;
            var creatorWrapper = function (creator, args) {
                return creator.apply(this, args);
            };

            function Context(config, loader) {
                if (!(this instanceof Context)) {
                    return new Context(config);
                }

                this.loader = loader || globalLoader;
                this.components = {};
                this.container = new Container(this);
                for (var id in config) {
                    this.addComponent(id, config[id]);
                }
            }

            /**
             * 向容器中注册构件，配置中，args 和 properties 中的每个元素，可以使用 $ref 操作符：
             *      {
         *        args: [ { $ref: 'otherComponent' } ]
         *     }
             *
             * 容器会解析第一层的$ref，从值中获取对应的实例，若实例未注册，返回 null
             *
             *
             * 在 properties 中，可以使用 $setter 操作符：
             *      {
         *          properties: { prop1: { $setter: 'setProp1'， value: 'prop1' } }
         *      }
             * 容器会解析第一层的$setter，从值中调用实例的方法，传入属性名和属性值，
             * 若未设置 setter，则使用instance.prop1 = value方式注入值
             *
             *
             * @param {String} id
             * @param {Object} config
             * @param {Function | String} config.creator 创建构件的函数或模块名称
             * @param {Boolean=false} config.isFactory 是否为工厂函数，默认false，会通过 new 方式调用，true 时直接调用
             * @param {'transient' | 'singleton' | 'static'} [config.scope = 'transient']
             * 构件作用域，默认为 transient，每次获取构件，都会新建一个实例返回，若为 singleton，则会返回同一个实例
             * 若为 static，则直接返回creator
             *
             * @param {Array} config.args 传递给创建构件函数的参数
             * @param {Object} config.properties 附加给实例的属性
             *      ioc.addComponent('List', {
         *          // 构造函数创建构件 new creator, 或者字符串，字符串则为 amd 模块名
         *          creator: require('./List'),
         *          scope: 'transient',
         *          args: [
         *              {
         *                   $ref: 'entityName'
         *              }
         *          ],
         *
         *          // 属性注入， 不设置$setter, 则直接instance.xxx = xxx
         *          properties: {
         *              model: { $ref: 'ListModel' },
         *              view: { $ref: 'ListView' },
         *              name: 'xxxx'
         *          }
         *      });
             */
            Context.prototype.addComponent = function (id, config) {
                var component = this.components[id];
                if (component) {
                    util.warn(id + 'has been add! This will be no effect');
                    return;
                }

                this.components[id] = createComponent(id, config);
                return this.components[id];
            };

            Context.prototype.getComponent = function (ids, cb) {
                ids = ids instanceof Array ? ids : [ids];
                var instances = Array(ids.length);
                var needLoadedModules = {};
                var me = this;
                for (var i = 0, len = ids.length; i < len; ++i) {
                    var type = ids[i];
                    var component = this.components[type];
                    if (!component) {
                        util.warn('`%s` has not been added to the Ioc', type);
                    }
                    else {
                        getComponentDeps(this, component, needLoadedModules);
                    }
                }

                loadComponentModules(this, needLoadedModules, function () {
                    for (var i = 0, len = ids.length; i < len; ++i) {
                        instances[i] = me.container.createInstance(me.components[ids[i]]);
                    }
                    cb.apply(null, instances);
                });

                return this;
            };

            Context.prototype.getComponentConfig = function (id) {
                return this.components[id];
            };

            Context.prototype.loader = function (loader) {
                this.loader = loader;
            };

            /**
             * 销毁容器，会遍历容器中的单例，如果有设置dispose，调用他们的 dispose 方法
             */
            Context.prototype.dispose = function () {
                this.container.dispose();
                this.components = {};
            };

            function createComponent(id, config) {
                var component = {
                    id: id,
                    args: config.args || [],
                    properties: config.properties || {},
                    argDeps: null,
                    propDeps: null,
                    scope: config.scope || 'transient',
                    creator: typeof config.creator === 'function' ? config.creator : null,
                    module: config.module || undefined,
                    isFactory: !!config.isFactory,
                    instance: null
                };

                // 有设置 creator，那么先包装下
                component.creator && createCreator(component);
                component.argDeps = parseArgDeps(component);
                component.propDeps = parsePropDeps(component);
                return component;
            }

            function parseArgDeps(component) {
                var deps = [];
                var args = component.args;
                for (var i = args.length - 1; i > -1; --i) {
                    util.hasReference(args[i]) && util.addToSet(deps, args[i].$ref);
                }
                return deps;
            }

            function parsePropDeps(component) {
                var deps = [];
                var properties = component.properties;
                for (var k in properties) {
                    if (util.hasOwnProperty(properties, k)) {
                        var prop = properties[k];
                        util.hasReference(prop) && util.addToSet(deps, prop.$ref);
                    }
                }
                return deps;
            }

            function createCreator(component) {
                // 给字面量组件和非工厂组件套一层 creator，后面构造实例就可以无需分支判断，直接调用 component.creator
                if (!component.isFactory && component.scope !== 'static') {
                    var constructor = component.creator;
                    component.creator = function () {
                        creatorWrapper.prototype = constructor.prototype;
                        return new creatorWrapper(constructor, arguments);
                    }
                }
            }

            function getComponentDeps(context, component, result, depTree) {
                if (!component) {
                    return;
                }

                var module = component.module;
                if (!component.creator && component.module) {
                    result[module] = result[module] || [];
                    result[module].push(component);
                }
                depTree = depTree || new DependencyTree();

                var circular = depTree.checkForCircular(component.id);
                if (circular) {
                    var msg = component.id + ' has circular dependencies ';
                    throw new util.CircularError(msg, component);
                }

                depTree.addData(component);
                var child = depTree.appendChild(new DependencyTree());

                var argDeps = component.argDeps;
                for (var i = argDeps.length - 1; i > -1; --i) {
                    getComponentDeps(context, context.components[argDeps[i]], result, child);
                }

                var propDps = component.propDeps;
                for (i = propDps.length - 1; i > -1; --i) {
                    getComponentDeps(context, context.components[propDps[i]], result, child);
                }
            }

            function loadComponentModules(context, moduleMaps, cb) {
                var modules = [];
                for (var k in moduleMaps) {
                    modules.push(k);
                }

                context.loader(modules, function () {
                    for (var i = arguments.length - 1; i > -1; --i) {
                        var creator = arguments[i];
                        var components = moduleMaps[modules[i]];
                        for (var j = components.length - 1; j > -1; --j) {
                            var component = components[j];
                            if (!component.creator) {
                                component.creator = creator;
                                createCreator(component);
                            }
                        }
                    }
                    cb();
                });
            }

            return Context;
        });

}(typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory; }, this);